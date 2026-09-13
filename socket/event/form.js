const mongoose = require("mongoose");
const db = require("../../models");
const { getSessionUserId, hasPermission, resolveUserPermissions } = require("../session");
const { createFormPdf } = require("../../utils/formPdf");
const { getConfiguredDropbox, normalizePathPart, uploadDocumentFile } = require("../../utils/documentStorage");
const { protectDocumentSocket, protectedDocumentEmitter, safeDocument } = require('../../utils/documentAccess');

const USER_SELECT = "username displayName firstName lastName portrait";

const hasFormPermission = (user, action, resource) => user?.role === "System"
    || hasPermission(user, "module", "document")
    || hasPermission(user, action, resource);

const cleanAnswers = (values, formSchema) => {
    const submitted = new Map((Array.isArray(values) ? values : [])
        .map((answer) => [String(answer.fieldId || ""), answer.value]));
    return (formSchema?.fields || [])
        .filter((field) => !["section", "instruction"].includes(field.type) && submitted.has(field.id))
        .map((field) => {
            const value = submitted.get(field.id);
            if (value === undefined || value === null || value === "")
                return { fieldId: field.id, value: "" };
            if (field.type === "checkbox")
                return { fieldId: field.id, value: value === true || value === "true" };
            if (field.type === "number")
                return { fieldId: field.id, value: Number(value) };
            if (field.type === "yesno")
                return { fieldId: field.id, value: ["Yes", "No", "N/A"].includes(value) ? value : "" };
            if (["choice", "select"].includes(field.type))
                return { fieldId: field.id, value: (field.options || []).includes(value) ? value : "" };
            return { fieldId: field.id, value: String(value).slice(0, 5000) };
        });
};

const validateAnswers = (answers, formSchema) => {
    const values = new Map(answers.map((answer) => [answer.fieldId, answer.value]));
    for (const field of formSchema?.fields || []) {
        if (["section", "instruction"].includes(field.type)) continue;
        const value = values.get(field.id);
        const empty = value === undefined || value === null || value === "" || (Array.isArray(value) && !value.length);
        if (field.required && empty) throw new Error(`${field.label} is required`);
        if (empty || field.type !== "number") continue;
        const number = Number(value);
        if (!Number.isFinite(number)) throw new Error(`${field.label} must be a number`);
        if (field.min !== null && field.min !== undefined && number < field.min)
            throw new Error(`${field.label} must be at least ${field.min}`);
        if (field.max !== null && field.max !== undefined && number > field.max)
            throw new Error(`${field.label} must be at most ${field.max}`);
    }
};

const asDate = (value, fallback = new Date()) => {
    const date = value ? new Date(value) : fallback;
    if (Number.isNaN(date.getTime())) throw new Error("A valid recorded date is required");
    return date;
};

module.exports = (rawSocket, rawIo) => {
    const socket = protectDocumentSocket(rawSocket);
    const io = protectedDocumentEmitter(rawIo);
    const requireUser = async (callback, action, resource) => {
        const userId = getSessionUserId(socket);
        if (!userId) {
            callback({ status: "error", message: "Not authenticated" });
            return null;
        }
        const user = await resolveUserPermissions(await db.user.findById(userId).lean());
        if (!user) {
            callback({ status: "error", message: "User not found" });
            return null;
        }
        if (hasFormPermission(user, action, resource)) return user;
        callback({ status: "error", message: "You do not have permission for this form action" });
        return null;
    };

    const getPublishedForm = async (documentId) => {
        if (!mongoose.isValidObjectId(documentId)) throw new Error("A valid form id is required");
        const document = await db.document.findOne({
            _id: documentId,
            type: "form",
            isTemplate: false,
            status: { $in: ["Published", "Review Overdue"] },
        }).lean();
        if (!document) throw new Error("Published form not found");
        if (document.expiryBehavior === "Deactivate" && document.expiresAt && new Date(document.expiresAt).getTime() <= Date.now())
            throw new Error("This form has expired. Use the current published form.");
        const revision = await db.documentRevision.findOne({
            document: document._id,
            revision: document.currentRevision,
        }).lean();
        if (!revision?.formSchema) throw new Error("Published form revision not found");
        return { document, revision };
    };

    const nextEntryNumber = async (document) => {
        const year = new Date().getUTCFullYear();
        const counter = await db.counter.findByIdAndUpdate(
            `form-entry:${document._id}:${year}`,
            { $inc: { sequence: 1 } },
            { new: true, upsert: true, setDefaultsOnInsert: true },
        );
        return `${document.documentNumber}-${year}-${String(counter.sequence).padStart(5, "0")}`;
    };

    const storeSubmissionPdf = async (document, revision, submission) => {
        revision = await safeDocument(revision, await require('../session').getActiveSessionUser(rawSocket), rawSocket);
        if (!(await getConfiguredDropbox())) throw new Error("Dropbox storage is required to submit a form entry");
        const buffer = await createFormPdf({
            document: revision,
            revision: revision.revision,
            formSchema: revision.formSchema,
            relatedDocuments: revision.relatedDocuments,
            submission,
        });
        const fileName = `${normalizePathPart(submission.entryNumber)}.pdf`;
        const artifact = await uploadDocumentFile({
            documentId: document._id,
            documentNumber: revision.documentNumber,
            revision: revision.revision,
            fileName,
            contents: buffer,
            category: "form-submissions",
        });
        if (!artifact) throw new Error("Unable to store the completed form in Dropbox");
        return artifact;
    };

    socket.on("form:generate", async ({ documentId, revision: requestedRevision } = {}, responseCallback) => {
        const callback = typeof responseCallback === "function" ? responseCallback : () => {};
        try {
            const user = await requireUser(callback, "create", "document.form.generate");
            if (!user) return;
            if (!mongoose.isValidObjectId(documentId))
                return callback({ status: "error", message: "A valid form id is required" });
            const document = await db.document.findOne({ _id: documentId, type: "form", isTemplate: false }).lean();
            if (!document) return callback({ status: "error", message: "Form not found" });
            if (!(await getConfiguredDropbox()))
                return callback({ status: "error", message: "Dropbox storage is required to generate a form" });

            const hasRequestedRevision = requestedRevision !== undefined && requestedRevision !== null;
            const parsedRevision = hasRequestedRevision ? Number(requestedRevision) : null;
            if (hasRequestedRevision && (!Number.isInteger(parsedRevision) || parsedRevision < 0))
                return callback({ status: "error", message: "A valid form revision is required" });
            const revision = hasRequestedRevision
                ? parsedRevision
                : (document.status === "Draft" || document.status === "In Review" ? 0 : document.currentRevision || 0);
            let snapshot = revision
                ? await db.documentRevision.findOne({ document: document._id, revision }).lean()
                : document;
            if (!snapshot?.formSchema) return callback({ status: "error", message: "Form definition not found" });
            snapshot = await safeDocument(snapshot, user, rawSocket);
            if (!snapshot.documentNumber)
                return callback({ status: "error", message: "A document number is required to generate the form" });

            const buffer = await createFormPdf({
                document: snapshot,
                revision,
                formSchema: snapshot.formSchema,
                relatedDocuments: snapshot.relatedDocuments,
            });
            const suffix = revision ? `rev-${revision}` : "draft";
            const fileName = `${normalizePathPart(snapshot.documentNumber)}-${suffix}-blank.pdf`;
            const artifact = await uploadDocumentFile({
                documentId: document._id,
                documentNumber: snapshot.documentNumber,
                revision,
                fileName,
                contents: buffer,
                category: "generated-form",
            });
            if (!artifact) throw new Error("Unable to store the generated form in Dropbox");
            callback({
                status: "success",
                message: "Form generated and stored in Dropbox",
                payload: { ...artifact, fileName, mimeType: "application/pdf", base64: buffer.toString("base64") },
            });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on("formSubmissions:get", async ({ documentId } = {}, responseCallback) => {
        const callback = typeof responseCallback === "function" ? responseCallback : () => {};
        try {
            const user = await requireUser(callback, "view", "document.form.entry.view");
            if (!user) return;
            if (!mongoose.isValidObjectId(documentId))
                return callback({ status: "error", message: "A valid form id is required" });
            const submissions = await db.formSubmission.find({ document: documentId })
                .sort({ recordedAt: -1, createdAt: -1 })
                .populate("createdBy updatedBy submittedBy", USER_SELECT)
                .lean();
            callback({ status: "success", message: "Form entries fetched", payload: submissions });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on("formSubmission:create", async (input = {}, responseCallback) => {
        const callback = typeof responseCallback === "function" ? responseCallback : () => {};
        try {
            const user = await requireUser(callback, "create", "document.form.entry.create");
            if (!user) return;
            const { document, revision } = await getPublishedForm(input.documentId);
            const answers = cleanAnswers(input.answers, revision.formSchema);
            if (input.status === "Submitted") validateAnswers(answers, revision.formSchema);
            const entryNumber = await nextEntryNumber(document);
            const submission = {
                document: document._id,
                formRevision: revision.revision,
                entryNumber,
                paperReference: String(input.paperReference || "").trim(),
                recordedAt: asDate(input.recordedAt),
                recordedBy: String(input.recordedBy || "").trim(),
                shift: String(input.shift || "").trim(),
                status: input.status === "Submitted" ? "Submitted" : "Draft",
                answers,
                notes: String(input.notes || "").trim(),
                createdBy: user._id,
                updatedBy: user._id,
                submittedBy: input.status === "Submitted" ? user._id : null,
                submittedAt: input.status === "Submitted" ? new Date() : null,
            };
            if (submission.status === "Submitted")
                submission.artifact = { format: "pdf", ...await storeSubmissionPdf(document, revision, submission) };
            const saved = await db.formSubmission.create(submission);
            const payload = await db.formSubmission.findById(saved._id)
                .populate("createdBy updatedBy submittedBy", USER_SELECT)
                .lean();
            io.emit("formSubmission:created", payload);
            callback({ status: "success", message: `${submission.status} form entry saved`, payload });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on("formSubmission:update", async (input = {}, responseCallback) => {
        const callback = typeof responseCallback === "function" ? responseCallback : () => {};
        try {
            const user = await requireUser(callback, "update", "document.form.entry.update");
            if (!user) return;
            if (!mongoose.isValidObjectId(input._id))
                return callback({ status: "error", message: "A valid form entry id is required" });
            const submission = await db.formSubmission.findById(input._id);
            if (!submission) return callback({ status: "error", message: "Form entry not found" });
            if (submission.status !== "Draft")
                return callback({ status: "error", message: "Only draft form entries can be edited" });
            const document = await db.document.findById(submission.document).lean();
            const revision = await db.documentRevision.findOne({
                document: submission.document,
                revision: submission.formRevision,
            }).lean();
            if (!document || !revision?.formSchema)
                return callback({ status: "error", message: "Form revision not found" });

            submission.answers = cleanAnswers(input.answers, revision.formSchema);
            submission.paperReference = String(input.paperReference || "").trim();
            submission.recordedAt = asDate(input.recordedAt, submission.recordedAt);
            submission.recordedBy = String(input.recordedBy || "").trim();
            submission.shift = String(input.shift || "").trim();
            submission.notes = String(input.notes || "").trim();
            submission.updatedBy = user._id;
            if (input.status === "Submitted") {
                validateAnswers(submission.answers, revision.formSchema);
                submission.artifact = { format: "pdf", ...await storeSubmissionPdf(document, revision, submission) };
                submission.status = "Submitted";
                submission.submittedBy = user._id;
                submission.submittedAt = new Date();
            }
            await submission.save();
            const payload = await db.formSubmission.findById(submission._id)
                .populate("createdBy updatedBy submittedBy", USER_SELECT)
                .lean();
            io.emit("formSubmission:updated", payload);
            callback({ status: "success", message: `${submission.status} form entry saved`, payload });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });
};
