const crypto = require("crypto");
const mongoose = require("mongoose");
const db = require("../../models");
const { getSessionUserId, hasPermission, resolveUserPermissions } = require("../session");
const {
    prepareAuditReferences,
    prepareDocumentList,
    prepareDocumentTemplates,
} = require("../../utils/documentSeed");
const { createDocumentDocx } = require("../../utils/documentDocx");
const { createFormPdf } = require("../../utils/formPdf");
const { getDropbox, getConfiguredDropbox, normalizePathPart, uploadDocumentFile } = require("../../utils/documentStorage");
const { createDocumentThumbnail } = require("../../utils/documentThumbnail");
const { cleanupDocumentResources } = require("../../utils/documentResources");
const { cleanDocumentPage } = require("../../utils/documentPage");
const { protectDocumentSocket, protectedDocumentEmitter, listDocument, safeDocument } = require('../../utils/documentAccess');
const { getActiveSessionUser } = require('../session');

const USER_SELECT = "username displayName firstName lastName portrait";
const DOCUMENT_POPULATE = [
    { path: "auditReferences", select: "name code description status sourceLinks" },
    { path: "owner", select: USER_SELECT },
    { path: "updatedBy", select: USER_SELECT },
    { path: "relatedDocuments.document", select: "title documentNumber documentCategory status currentRevision" },
];

const asText = (node) => {
    if (!node) return "";
    if (Array.isArray(node)) return node.map(asText).filter(Boolean).join(" ");
    if (node.type === "text") return node.text || "";
    if (!Array.isArray(node.content)) return "";
    return node.content.map(asText).filter(Boolean).join(node.type === "paragraph" ? " " : "\n");
};

const cleanStrings = (values) => Array.from(new Set(
    (Array.isArray(values) ? values : [])
        .map((value) => String(value || "").trim())
        .filter(Boolean),
)).slice(0, 30);

const FORM_FIELD_TYPES = new Set([
    "section", "instruction", "text", "textarea", "number", "date", "time",
    "checkbox", "yesno", "choice", "select", "signature",
]);

const cleanFormSchema = (value = {}) => ({
    instructions: String(value.instructions || "").trim().slice(0, 2000),
    page: {
        size: value.page?.size === "A4" ? "A4" : "LETTER",
        orientation: value.page?.orientation === "landscape" ? "landscape" : "portrait",
    },
    fields: (Array.isArray(value.fields) ? value.fields : []).slice(0, 150).map((field) => ({
        id: String(field.id || crypto.randomUUID()).trim().slice(0, 100),
        type: FORM_FIELD_TYPES.has(field.type) ? field.type : "text",
        label: String(field.label || "Untitled field").trim().slice(0, 300),
        help: String(field.help || "").trim().slice(0, 500),
        required: Boolean(field.required),
        unit: String(field.unit || "").trim().slice(0, 50),
        min: Number.isFinite(Number(field.min)) && field.min !== "" ? Number(field.min) : null,
        max: Number.isFinite(Number(field.max)) && field.max !== "" ? Number(field.max) : null,
        options: cleanStrings(field.options).slice(0, 30),
    })),
});

const formSchemaText = (schema) => [
    schema.instructions,
    ...schema.fields.flatMap((field) => [field.label, field.help, ...(field.options || [])]),
].filter(Boolean).join(" ");

const resolveRelatedDocuments = async (values) => {
    const ids = cleanStrings(values).filter((id) => mongoose.isValidObjectId(id));
    if (!ids.length) return [];
    const documents = await db.document.find({
        _id: { $in: ids },
        isTemplate: false,
        documentCategory: { $in: ["Procedure", "Work Instruction"] },
        status: { $in: ["Published", "Review Overdue"] },
    }).select("title documentNumber currentRevision").lean();
    const byId = new Map(documents.map((document) => [String(document._id), document]));
    return ids.map((id) => byId.get(id)).filter(Boolean).map((document) => ({
        document: document._id,
        role: "SOP",
        revision: document.currentRevision,
        title: document.title,
        documentNumber: document.documentNumber,
    }));
};

const cleanSourceLinks = (values) => (Array.isArray(values) ? values : [])
    .map((item) => {
        try {
            const url = new URL(String(item?.url || "").trim());
            if (!["http:", "https:"].includes(url.protocol)) return null;
            return {
                label: String(item?.label || "Reference source").trim().slice(0, 100),
                url: url.toString(),
            };
        } catch {
            return null;
        }
    })
    .filter(Boolean)
    .slice(0, 10);

const toDate = (value) => {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
};

const DOCUMENT_CATEGORY_CODES = {
    Policy: "POL",
    Procedure: "SOP",
    "Work Instruction": "WI",
    Manual: "MAN",
    Form: "FRM",
    Plan: "PLN",
    Record: "REC",
    Report: "RPT",
    Specification: "SPEC",
    Guideline: "GDL",
    Other: "DOC",
};

const normalizeDocumentCategory = (value) => Object.hasOwn(DOCUMENT_CATEGORY_CODES, value) ? value : "Other";

const nextDocumentNumber = async (documentCategory) => {
    const type = DOCUMENT_CATEGORY_CODES[normalizeDocumentCategory(documentCategory)];

    while (true) {
        const counter = await db.counter.findByIdAndUpdate(
            `document:${type}`,
            { $inc: { sequence: 1 } },
            { new: true, upsert: true, setDefaultsOnInsert: true },
        );
        const documentNumber = `QMS-${type}-${String(counter.sequence).padStart(3, "0")}`;
        if (!await db.document.exists({ documentNumber })) return documentNumber;
    }
};

const liveStatus = (document) => {
    if (document.status === "Archived") return "Archived";
    if (!["Published", "Review Overdue", "Expired"].includes(document.status))
        return document.status;

    const now = Date.now();
    if (document.expiresAt && document.expiryBehavior === "Deactivate" && new Date(document.expiresAt).getTime() <= now)
        return "Expired";
    if (document.reviewDueAt && new Date(document.reviewDueAt).getTime() <= now)
        return "Review Overdue";
    return "Published";
};

const serializeDocument = (document) => {
    if (!document) return document;
    const value = document.toObject ? document.toObject() : { ...document };
    value.status = liveStatus(value);
    return value;
};

const hasDocumentPermission = (user, action, resource) => {
    if (!user) return false;
    if (user.role === "System") return true;
    return hasPermission(user, "module", "document")
        || hasPermission(user, action, resource);
};

const safeCallback = (callback) => typeof callback === "function" ? callback : () => {};

module.exports = (rawSocket, rawIo) => {
    const socket = protectDocumentSocket(rawSocket);
    const io = protectedDocumentEmitter(rawIo);
    const requireUser = async (callback) => {
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
        return user;
    };

    const requireAccess = (user, action, resource, callback) => {
        if (hasDocumentPermission(user, action, resource)) return true;
        callback({ status: "error", message: "You do not have permission for this document action" });
        return false;
    };

    socket.on("documents:get", async (query = {}, responseCallback) => {
        const callback = safeCallback(responseCallback);
        try {
            const user = await requireUser(callback);
            if (!user || !requireAccess(user, "view", "document.article.view", callback)) return;
            if (query.isTemplate) await prepareDocumentTemplates();
            else await prepareDocumentList();

            const filter = {};
            if (query.isTemplate !== undefined) filter.isTemplate = Boolean(query.isTemplate);
            if (query.status && query.status !== "All") filter.status = query.status;
            if (query.folder && query.folder !== "All") filter.folder = query.folder;
            if (query.auditReferenceId && mongoose.isValidObjectId(query.auditReferenceId))
                filter.auditReferences = query.auditReferenceId;
            if (String(query.search || "").trim())
                filter.$text = { $search: String(query.search).trim() };

            const documents = await db.document.find(filter)
                .sort(query.isTemplate ? { title: 1 } : { updatedAt: -1 })
                .populate(DOCUMENT_POPULATE)
                .lean();
            const currentUser = await getActiveSessionUser(rawSocket);
            const policies = await db.document.find({ _id: { $in: documents.map(document => document._id) } })
                .select('_id owner createdBy locked visibility viewerIds hasPassword securityVersion').lean();
            const policyById = new Map(policies.map(document => [String(document._id), document]));

            callback({
                status: "success",
                message: "Documents fetched",
                payload: (await Promise.all(documents.filter(document => policyById.has(String(document._id)))
                    .map(document => listDocument({ ...serializeDocument(document), ...policyById.get(String(document._id)) }, currentUser, rawSocket)))).filter(Boolean),
            });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on("document:get", async ({ _id } = {}, responseCallback) => {
        const callback = safeCallback(responseCallback);
        try {
            const user = await requireUser(callback);
            if (!user || !requireAccess(user, "view", "document.article.view", callback)) return;
            if (!mongoose.isValidObjectId(_id))
                return callback({ status: "error", message: "A valid document id is required" });

            const document = await db.document.findById(_id)
                .populate(DOCUMENT_POPULATE)
                .lean();
            if (!document) return callback({ status: "error", message: "Document not found" });

            callback({ status: "success", message: "Document fetched", payload: serializeDocument(document) });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on("document:create", async (input = {}, responseCallback) => {
        const callback = safeCallback(responseCallback);
        try {
            const user = await requireUser(callback);
            if (!user || !requireAccess(user, "create", "document.article.create", callback)) return;
            if (input.templateId) await prepareDocumentTemplates();
            else await prepareDocumentList();

            let source = null;
            if (input.templateId) {
                if (!mongoose.isValidObjectId(input.templateId))
                    return callback({ status: "error", message: "Invalid template id" });
                source = await db.document.findOne({ _id: input.templateId, isTemplate: true }).lean();
                if (!source) return callback({ status: "error", message: "Template not found" });
            }

            const title = String(input.title || source?.title || "Untitled document").trim();
            const folder = String(input.folder || (source ? "Policies" : "General")).trim();
            const isForm = input.documentMode === "form" || source?.type === "form";
            const documentCategory = isForm
                ? "Form"
                : normalizeDocumentCategory(input.documentCategory || source?.documentCategory);
            const documentNumber = input.autoDocumentNumber === true
                ? await nextDocumentNumber(documentCategory)
                : String(input.documentNumber || "").trim();
            if (isForm && !documentNumber)
                return callback({ status: "error", message: "A document number is required for every form" });
            const formSchema = isForm ? cleanFormSchema(source?.formSchema || input.formSchema) : undefined;
            const sourceRelatedDocumentIds = source?.relatedDocuments?.map((item) => item.document);
            const relatedDocuments = isForm
                ? await resolveRelatedDocuments(input.relatedDocumentIds ?? sourceRelatedDocumentIds)
                : [];
            if (input._id !== undefined && !mongoose.isValidObjectId(input._id))
                return callback({ status: "error", message: "A valid document id is required" });
            const document = await db.document.create({
                _id: input._id || new mongoose.Types.ObjectId(),
                title,
                documentNumber,
                documentCategory,
                summary: String(input.summary || source?.summary || "").trim(),
                type: isForm ? "form" : "article",
                folder,
                tags: cleanStrings(input.tags),
                auditReferences: Array.isArray(input.auditReferenceIds) ? input.auditReferenceIds : [],
                status: "Draft",
                contentJson: source?.contentJson || input.contentJson,
                page: cleanDocumentPage(source?.page || input.page),
                watermark: source?.watermark || "",
                watermarkText: source?.watermarkText || "",
                watermarkLayout: source?.watermarkLayout || "single",
                formSchema,
                relatedDocuments,
                plainText: isForm ? formSchemaText(formSchema) : source?.plainText || asText(input.contentJson),
                owner: user._id,
                createdBy: user._id,
                updatedBy: user._id,
                sourceTemplate: source?._id,
                reviewIntervalMonths: Number(input.reviewIntervalMonths) || 12,
                expiresAt: toDate(input.expiresAt),
                expiryBehavior: input.expiryBehavior === "Deactivate" ? "Deactivate" : "Warn",
            });

            const payload = await db.document.findById(document._id)
                .populate(DOCUMENT_POPULATE)
                .lean();
            io.emit("document:created", serializeDocument(payload));
            callback({ status: "success", message: "Draft created", payload: serializeDocument(payload) });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on("documentTemplate:create", async (input = {}, responseCallback) => {
        const callback = safeCallback(responseCallback);
        try {
            const user = await requireUser(callback);
            if (!user || !requireAccess(user, "create", "document.template.create", callback)) return;
            if (!mongoose.isValidObjectId(input.documentId))
                return callback({ status: "error", message: "A valid source document id is required" });
            const source = await db.document.findOne({ _id: input.documentId, isTemplate: false }).lean();
            if (!source) return callback({ status: "error", message: "Source document not found" });
            if (source.visibility === 'selected' || source.hasPassword)
                return callback({ status: 'error', message: 'Restricted documents cannot be copied to shared templates' });

            const template = await db.document.create({
                title: String(input.title || `${source.title} template`).trim(),
                summary: String(input.summary || source.summary || "").trim(),
                type: source.type === "form" ? "form" : "article",
                documentCategory: source.documentCategory || "Other",
                folder: "Policy templates",
                tags: source.tags,
                auditReferences: source.auditReferences,
                status: "Published",
                contentJson: source.contentJson,
                page: cleanDocumentPage(source.page),
                watermark: source.watermark || "",
                watermarkText: source.watermarkText || "",
                watermarkLayout: source.watermarkLayout || "single",
                formSchema: source.type === "form" ? source.formSchema : undefined,
                relatedDocuments: source.type === "form" ? source.relatedDocuments : [],
                plainText: source.plainText,
                owner: user._id,
                createdBy: user._id,
                updatedBy: user._id,
                isTemplate: true,
                systemManaged: false,
                templateVersion: 1,
                currentRevision: 1,
                publishedAt: new Date(),
                reviewIntervalMonths: source.reviewIntervalMonths || 12,
            });
            const payload = await db.document.findById(template._id)
                .populate(DOCUMENT_POPULATE)
                .lean();
            io.emit("documentTemplate:created", payload);
            callback({ status: "success", message: "Reusable template created", payload });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on("documentFile:create", async (input = {}, responseCallback) => {
        const callback = safeCallback(responseCallback);
        try {
            const user = await requireUser(callback);
            if (!user || !requireAccess(user, "create", "document.file.create", callback)) return;
            const allowedTypes = [
                "image/jpeg",
                "image/png",
                "image/webp",
                "application/pdf",
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            ];
            if (!allowedTypes.includes(input.mimeType))
                return callback({ status: "error", message: "Upload a PDF, DOCX, PNG, JPEG, or WebP file" });

            let contents;
            if (Buffer.isBuffer(input.content)) contents = input.content;
            else if (input.content instanceof ArrayBuffer) contents = Buffer.from(input.content);
            else if (ArrayBuffer.isView(input.content)) contents = Buffer.from(input.content.buffer, input.content.byteOffset, input.content.byteLength);
            else contents = Buffer.from(String(input.content || ""), "base64");
            if (!contents.length || contents.length > 8 * 1024 * 1024)
                return callback({ status: "error", message: "File must be between 1 byte and 8 MB" });
            if (input.mimeType === "application/pdf" && !contents.subarray(0, 1024).includes(Buffer.from("%PDF-")))
                return callback({ status: "error", message: "Upload a valid PDF file" });

            const dropbox = await getConfiguredDropbox();
            if (!dropbox)
                return callback({ status: "error", message: "Dropbox storage is not configured in MES" });
            const originalName = String(input.fileName || "file").trim();
            const title = String(input.title || originalName.replace(/\.[^.]+$/, "")).trim();
            if (!title) return callback({ status: "error", message: "A document title is required" });
            const documentCategory = normalizeDocumentCategory(input.documentCategory || "Record");
            const documentNumber = input.autoDocumentNumber === true
                ? await nextDocumentNumber(documentCategory)
                : String(input.documentNumber || "").trim();

            const documentId = new mongoose.Types.ObjectId();
            const fileName = normalizePathPart(input.fileName);
            const stored = await uploadDocumentFile({
                documentId,
                revision: 0,
                fileName,
                contents,
                category: "original",
                dropbox,
            });
            if (!stored?.url || !stored.storagePath) throw new Error("Unable to save the document file to Dropbox");
            const asset = {
                name: originalName,
                mimeType: input.mimeType,
                size: contents.length,
                purpose: "attachment",
                ...stored,
                uploadedAt: new Date(),
                uploadedBy: user._id,
            };
            const document = await db.document.create({
                _id: documentId,
                title,
                documentNumber,
                summary: String(input.summary || "Externally managed document file.").trim(),
                type: "uploaded-file",
                documentCategory,
                folder: String(input.folder || "Uploaded files").trim(),
                status: "Draft",
                contentJson: {
                    type: "doc",
                    content: [{
                        type: "paragraph",
                        content: [{ type: "text", text: `Original file: ${originalName}` }],
                    }],
                },
                plainText: `Original file: ${originalName}`,
                owner: user._id,
                createdBy: user._id,
                updatedBy: user._id,
                attachments: [asset],
            });
            const payload = await db.document.findById(document._id)
                .populate(DOCUMENT_POPULATE)
                .lean();
            io.emit("document:created", serializeDocument(payload));
            callback({ status: "success", message: "Document file uploaded", payload: serializeDocument(payload) });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on("document:update", async (input = {}, responseCallback) => {
        const callback = safeCallback(responseCallback);
        try {
            const user = await requireUser(callback);
            if (!user || !requireAccess(user, "update", "document.article.update", callback)) return;
            if (!mongoose.isValidObjectId(input._id))
                return callback({ status: "error", message: "A valid document id is required" });

            const document = await db.document.findById(input._id);
            if (!document) return callback({ status: "error", message: "Document not found" });
            if (document.isTemplate && document.systemManaged)
                return callback({ status: "error", message: "System templates cannot be edited directly" });
            if (document.status === "Archived")
                return callback({ status: "error", message: "Archived documents cannot be edited" });
            document.$where = { locked: { $ne: true }, securityVersion: document.securityVersion || { $in: [null, 0] } };

            if (input.title !== undefined) document.title = String(input.title).trim();
            if (!document.title) return callback({ status: "error", message: "Title is required" });
            if (input.documentNumber !== undefined) document.documentNumber = String(input.documentNumber).trim();
            if (input.documentCategory !== undefined)
                document.documentCategory = normalizeDocumentCategory(input.documentCategory);
            if (input.summary !== undefined) document.summary = String(input.summary).trim();
            if (input.folder !== undefined) document.folder = String(input.folder).trim() || "General";
            if (input.tags !== undefined) document.tags = cleanStrings(input.tags);
            if (input.auditReferenceIds !== undefined)
                document.auditReferences = Array.isArray(input.auditReferenceIds) ? input.auditReferenceIds : [];
            if (input.contentJson !== undefined) {
                document.contentJson = input.contentJson;
                document.plainText = asText(input.contentJson).replace(/\s+/g, " ").trim();
                document.markModified("contentJson");
            }
            if (input.page !== undefined) document.page = cleanDocumentPage(input.page);
            if (input.watermark !== undefined) {
                document.watermark = ["manufacturer", "confidential", "custom"].includes(input.watermark)
                    ? input.watermark
                    : "";
                document.watermarkText = document.watermark
                    ? String(input.watermarkText || (document.watermark === "confidential" ? "CONFIDENTIAL" : "MANUFACTURING"))
                        .trim()
                        .slice(0, 120)
                    : "";
            }
            if (document.type === "form" && input.formSchema !== undefined) {
                document.formSchema = cleanFormSchema(input.formSchema);
                document.plainText = formSchemaText(document.formSchema);
                document.markModified("formSchema");
            }
            if (document.type === "form" && input.relatedDocumentIds !== undefined)
                document.relatedDocuments = await resolveRelatedDocuments(input.relatedDocumentIds);
            if (input.status === "In Review" || input.status === "Draft") document.status = input.status;
            if (input.reviewIntervalMonths !== undefined)
                document.reviewIntervalMonths = Math.min(120, Math.max(1, Number(input.reviewIntervalMonths) || 12));
            if (input.expiresAt !== undefined) document.expiresAt = toDate(input.expiresAt);
            if (input.expiryBehavior !== undefined)
                document.expiryBehavior = input.expiryBehavior === "Deactivate" ? "Deactivate" : "Warn";
            document.updatedBy = user._id;
            await document.save();

            const payload = await db.document.findById(document._id)
                .populate(DOCUMENT_POPULATE)
                .lean();
            io.emit("document:updated", serializeDocument(payload));
            callback({ status: "success", message: "Document saved", payload: serializeDocument(payload) });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on("document:publish", async (input = {}, responseCallback) => {
        const callback = safeCallback(responseCallback);
        try {
            const user = await requireUser(callback);
            if (!user || !requireAccess(user, "approve", "document.article.publish", callback)) return;
            if (!mongoose.isValidObjectId(input._id))
                return callback({ status: "error", message: "A valid document id is required" });

            const document = await db.document.findById(input._id);
            if (!document || document.isTemplate)
                return callback({ status: "error", message: "Document not found" });
            if (document.status !== "In Review")
                return callback({ status: "error", message: "Submit the document for review before publishing" });
            if (document.type === "form" && !document.documentNumber)
                return callback({ status: "error", message: "A document number is required for every form" });
            if (document.type === "form" && !document.formSchema?.fields?.length)
                return callback({ status: "error", message: "Add at least one field before publishing the form" });
            if (document.type !== "form" && !document.plainText.trim())
                return callback({ status: "error", message: "Add document content before publishing" });
            if (document.type === "form" && !getDropbox())
                return callback({ status: "error", message: "Dropbox storage is required to publish a form" });

            const now = new Date();
            const nextRevision = document.currentRevision + 1;
            const reviewDueAt = new Date(now);
            reviewDueAt.setMonth(reviewDueAt.getMonth() + (document.reviewIntervalMonths || 12));
            const snapshot = {
                document: document._id,
                revision: nextRevision,
                title: document.title,
                documentNumber: document.documentNumber,
                documentCategory: document.documentCategory,
                summary: document.summary,
                contentJson: document.contentJson,
                page: cleanDocumentPage(document.page),
                watermark: document.watermark,
                watermarkText: document.watermarkText,
                watermarkLayout: document.watermarkLayout,
                formSchema: document.formSchema,
                relatedDocuments: document.relatedDocuments,
                plainText: document.plainText,
                tags: document.tags,
                auditReferences: document.auditReferences,
                effectiveAt: toDate(input.effectiveAt) || now,
                reviewDueAt,
                expiresAt: document.expiresAt,
                expiryBehavior: document.expiryBehavior,
                changeSummary: String(input.changeSummary || "").trim(),
                publishedBy: user._id,
                publishedAt: now,
            };
            const revisionContent = document.type === "form"
                ? snapshot.formSchema
                : {
                    contentJson: snapshot.contentJson,
                    page: snapshot.page,
                    watermark: snapshot.watermark,
                    watermarkText: snapshot.watermarkText,
                    watermarkLayout: snapshot.watermarkLayout,
                };
            snapshot.contentHash = crypto.createHash("sha256")
                .update(JSON.stringify(revisionContent))
                .digest("hex");

            if (document.type === "form") {
                const fileName = `${normalizePathPart(document.documentNumber)}-rev-${nextRevision}-blank.pdf`;
                const buffer = await createFormPdf({
                    document,
                    revision: nextRevision,
                    formSchema: snapshot.formSchema,
                    relatedDocuments: snapshot.relatedDocuments,
                });
                const artifact = await uploadDocumentFile({
                    documentId: document._id,
                    documentNumber: document.documentNumber,
                    revision: nextRevision,
                    fileName,
                    contents: buffer,
                    category: "published-form",
                });
                if (!artifact) throw new Error("Unable to store the published form in Dropbox");
                snapshot.artifacts = [{ format: "pdf", ...artifact }];
            }

            const revision = await db.documentRevision.create(snapshot);
            document.status = "Published";
            document.currentRevision = nextRevision;
            document.effectiveAt = snapshot.effectiveAt;
            document.reviewDueAt = reviewDueAt;
            document.publishedAt = now;
            document.updatedBy = user._id;
            await document.save();

            try {
                if (document.type !== "form") {
                    const fileName = `${normalizePathPart(document.documentNumber || document.title)}-rev-${nextRevision}.docx`;
                    const buffer = await createDocumentDocx({ ...snapshot, title: document.title });
                    const artifact = await uploadDocumentFile({
                        documentId: document._id,
                        revision: nextRevision,
                        fileName,
                        contents: buffer,
                        category: "published",
                    });
                    if (artifact) {
                        revision.artifacts.push({ format: "docx", ...artifact });
                        await revision.save();
                    }
                }
                const thumbnailFileName = `${normalizePathPart(document.documentNumber || document.title)}-rev-${nextRevision}.png`;
                const thumbnail = await uploadDocumentFile({
                    documentId: document._id,
                    revision: nextRevision,
                    fileName: thumbnailFileName,
                    contents: createDocumentThumbnail({
                        title: document.title,
                        documentNumber: document.documentNumber,
                        revision: nextRevision,
                    }),
                    category: "thumbnail",
                });
                if (thumbnail) {
                    document.thumbnail = {
                        kind: "generated",
                        ...thumbnail,
                        updatedAt: new Date(),
                    };
                    await document.save();
                }
            } catch (artifactError) {
                console.error("Document artifact generation:", artifactError.message);
            }

            const payload = await db.document.findById(document._id)
                .populate(DOCUMENT_POPULATE)
                .lean();
            io.emit("document:updated", serializeDocument(payload));
            callback({ status: "success", message: `Revision ${nextRevision} published`, payload: serializeDocument(payload) });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on("document:archive", async ({ _id } = {}, responseCallback) => {
        const callback = safeCallback(responseCallback);
        try {
            const user = await requireUser(callback);
            if (!user || !requireAccess(user, "delete", "document.article.archive", callback)) return;
            if (!mongoose.isValidObjectId(_id))
                return callback({ status: "error", message: "A valid document id is required" });

            const document = await db.document.findOne({ _id, isTemplate: false });
            if (!document) return callback({ status: "error", message: "Document not found" });
            document.status = "Archived";
            document.updatedBy = user._id;
            await document.save();

            io.emit("document:archived", String(document._id));
            callback({ status: "success", message: "Document archived", payload: String(document._id) });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on("documentRevisions:get", async ({ documentId } = {}, responseCallback) => {
        const callback = safeCallback(responseCallback);
        try {
            const user = await requireUser(callback);
            if (!user || !requireAccess(user, "view", "document.article.view", callback)) return;
            if (!mongoose.isValidObjectId(documentId))
                return callback({ status: "error", message: "A valid document id is required" });

            const revisions = await db.documentRevision.find({ document: documentId })
                .sort({ revision: -1 })
                .populate("publishedBy", USER_SELECT)
                .lean();
            callback({ status: "success", message: "Revisions fetched", payload: revisions });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on("document:exportDocx", async (input = {}, responseCallback) => {
        const callback = safeCallback(responseCallback);
        try {
            const user = await requireUser(callback);
            if (!user || !requireAccess(user, "view", "document.article.export", callback)) return;
            if (!mongoose.isValidObjectId(input._id))
                return callback({ status: "error", message: "A valid document id is required" });

            const document = await db.document.findById(input._id).lean();
            if (!document) return callback({ status: "error", message: "Document not found" });

            let source = document;
            const requestedRevision = input.revision
                || (["Published", "Review Overdue", "Expired"].includes(document.status) ? document.currentRevision : 0);
            if (requestedRevision) {
                source = await db.documentRevision.findOne({
                    document: document._id,
                    revision: Number(requestedRevision),
                }).lean();
                if (!source) return callback({ status: "error", message: "Revision not found" });
            }

            const revisionNumber = source.revision || 0;
            const suffix = revisionNumber ? `rev-${revisionNumber}` : "draft";
            const contentLabel = document.type === "uploaded-file" ? "-notes" : "";
            const fileName = `${normalizePathPart(source.documentNumber || source.title)}${contentLabel}-${suffix}.docx`;
            const buffer = await createDocumentDocx(await safeDocument({ ...source, watermark: document.watermark, watermarkText: document.watermarkText, watermarkLayout: document.watermarkLayout }, user, rawSocket));
            const artifact = revisionNumber ? await uploadDocumentFile({
                documentId: document._id,
                revision: revisionNumber,
                fileName,
                contents: buffer,
                category: "published",
            }) : null;

            if (artifact && source._id !== document._id) {
                const revision = await db.documentRevision.findById(source._id);
                revision.artifacts = revision.artifacts.filter((item) => item.format !== "docx");
                revision.artifacts.push({ format: "docx", ...artifact });
                await revision.save();
            }

            callback({
                status: "success",
                message: "Word document generated",
                payload: {
                    fileName,
                    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                    base64: buffer.toString("base64"),
                    artifact,
                },
            });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on("documentAsset:upload", async (input = {}, responseCallback) => {
        const callback = safeCallback(responseCallback);
        try {
            const user = await requireUser(callback);
            if (!user || !requireAccess(user, "update", "document.article.update", callback)) return;
            if (!mongoose.isValidObjectId(input.documentId))
                return callback({ status: "error", message: "A valid document id is required" });

            const document = await db.document.findOne({
                _id: input.documentId,
                isTemplate: false,
                status: { $ne: "Archived" },
            });
            if (!document) return callback({ status: "error", message: "Document not found" });

            const allowedTypes = [
                "image/jpeg",
                "image/png",
                "image/webp",
                "application/pdf",
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            ];
            if (input.kind !== 'attachment' && !allowedTypes.slice(0, 3).includes(input.mimeType))
                return callback({ status: "error", message: "Unsupported document asset type" });
            if (input.kind === "thumbnail" && !input.mimeType.startsWith("image/"))
                return callback({ status: "error", message: "A thumbnail must be an image" });

            let contents;
            if (Buffer.isBuffer(input.content)) contents = input.content;
            else if (input.content instanceof ArrayBuffer) contents = Buffer.from(input.content);
            else if (ArrayBuffer.isView(input.content)) contents = Buffer.from(input.content.buffer);
            else contents = Buffer.from(String(input.content || ""), "base64");
            const size = input.url ? Number(input.size) : contents.length;
            if (!Number.isInteger(size) || size < 1 || size > 8 * 1024 * 1024)
                return callback({ status: "error", message: "File must be between 1 byte and 8 MB" });

            const fileName = normalizePathPart(input.fileName);
            let stored;
            if (input.url) {
                const url = new URL(input.url);
                const category = input.kind === "thumbnail" ? "thumbnail" : "assets";
                const prefix = `/DocumentCenter/${document._id}/${category}/`;
                const storagePath = String(input.storagePath || "");
                if (url.protocol !== "https:" || !["dropbox.com", "www.dropbox.com", "dl.dropboxusercontent.com"].includes(url.hostname)
                    || url.username || url.password || url.port
                    || !storagePath.startsWith(prefix) || !/^[a-zA-Z0-9._-]+$/.test(storagePath.slice(prefix.length)))
                    return callback({ status: "error", message: "Invalid Dropbox asset location" });
                stored = { url: url.href, storagePath };
            } else stored = await uploadDocumentFile({
                documentId: document._id,
                revision: document.currentRevision || 0,
                fileName,
                contents,
                category: input.kind === "thumbnail" ? "thumbnail" : "assets",
            });
            if (!stored)
                return callback({ status: "error", message: "Dropbox storage is not configured on the server" });

            const asset = {
                name: fileName,
                mimeType: input.mimeType,
                size,
                purpose: input.kind === "image" ? "resource" : "attachment",
                ...stored,
                uploadedAt: new Date(),
                uploadedBy: user._id,
            };
            if (input.kind === "thumbnail") {
                if (!input.mimeType.startsWith("image/"))
                    return callback({ status: "error", message: "A thumbnail must be an image" });
                document.thumbnail = {
                    kind: "uploaded",
                    ...stored,
                    updatedAt: new Date(),
                };
                document.updatedBy = user._id;
                await document.save();
            } else {
                await db.document.updateOne(
                    { _id: document._id, isTemplate: false, status: { $ne: "Archived" }, "attachments.storagePath": { $ne: stored.storagePath } },
                    { $push: { attachments: asset }, $set: { updatedBy: user._id } },
                    { runValidators: true },
                );
            }

            const payload = await db.document.findById(document._id)
                .populate(DOCUMENT_POPULATE)
                .lean();
            if (!payload || payload.status === "Archived" || payload.isTemplate)
                return callback({ status: "error", message: "Document is no longer available for uploads" });
            const registeredAsset = input.kind === "thumbnail" ? asset : payload.attachments.find((item) => item.storagePath === stored.storagePath);
            if (!registeredAsset)
                return callback({ status: "error", message: "Unable to register the uploaded file" });
            io.emit("document:updated", serializeDocument(payload));
            callback({
                status: "success",
                message: "Asset uploaded",
                payload: { asset: registeredAsset, document: serializeDocument(payload) },
            });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on("documentResources:cleanup", async (input = {}, responseCallback) => {
        const callback = safeCallback(responseCallback);
        try {
            const user = await requireUser(callback);
            if (!user || !requireAccess(user, "update", "document.article.update", callback)) return;
            if (!mongoose.isValidObjectId(input.documentId))
                return callback({ status: "error", message: "A valid document id is required" });
            const document = await db.document.findOne({ _id: input.documentId, isTemplate: false, status: { $ne: "Archived" } }).lean();
            if (!document) return callback({ status: "error", message: "Document not found" });
            if (typeof input.accessToken !== "string" || !input.accessToken)
                return callback({ status: "error", message: "Dropbox authorization is required" });
            if (!Array.isArray(input.resourceIds) || input.resourceIds.some((id) => !mongoose.isValidObjectId(id)))
                return callback({ status: "error", message: "Valid resource ids are required" });
            const { Dropbox } = require("dropbox");
            const { collaboration } = require("../collaboration");
            await cleanupDocumentResources({
                documentId: document._id,
                resourceIds: input.resourceIds,
                db,
                dropbox: new Dropbox({ accessToken: input.accessToken, fetch }),
                liveDocuments: collaboration.documents,
            });
            const payload = await db.document.findById(document._id).populate(DOCUMENT_POPULATE).lean();
            io.emit("document:updated", serializeDocument(payload));
            callback({ status: "success", payload: serializeDocument(payload) });
        } catch (error) {
            callback({ status: "error", message: "Unable to clean up unused document resources. Please save again to retry." });
        }
    });

    socket.on("auditReferences:get", async (_, responseCallback) => {
        const callback = safeCallback(responseCallback);
        try {
            const user = await requireUser(callback);
            if (!user || !requireAccess(user, "view", "document.article.view", callback)) return;
            await prepareAuditReferences();
            const references = await db.auditReference.find({ status: "Active" }).sort({ name: 1 }).lean();
            callback({ status: "success", message: "Audit references fetched", payload: references });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on("auditReference:create", async (input = {}, responseCallback) => {
        const callback = safeCallback(responseCallback);
        try {
            const user = await requireUser(callback);
            if (!user || !requireAccess(user, "create", "document.auditReference.create", callback)) return;
            const name = String(input.name || "").trim();
            const code = String(input.code || "").trim().toUpperCase();
            if (!name || !code) return callback({ status: "error", message: "Name and badge code are required" });

            const reference = await db.auditReference.create({
                name,
                code,
                description: String(input.description || "").trim(),
                contentJson: input.contentJson,
                sourceLinks: cleanSourceLinks(input.sourceLinks),
                createdBy: user._id,
                updatedBy: user._id,
            });
            io.emit("auditReference:created", reference.toObject());
            callback({ status: "success", message: "Audit reference created", payload: reference.toObject() });
        } catch (error) {
            callback({ status: "error", message: error.code === 11000 ? "Badge code already exists" : error.message });
        }
    });

    socket.on("auditReference:update", async (input = {}, responseCallback) => {
        const callback = safeCallback(responseCallback);
        try {
            const user = await requireUser(callback);
            if (!user || !requireAccess(user, "update", "document.auditReference.update", callback)) return;
            if (!mongoose.isValidObjectId(input._id))
                return callback({ status: "error", message: "A valid reference id is required" });

            const reference = await db.auditReference.findById(input._id);
            if (!reference) return callback({ status: "error", message: "Audit reference not found" });
            if (input.name !== undefined) reference.name = String(input.name).trim();
            if (input.code !== undefined) reference.code = String(input.code).trim().toUpperCase();
            if (input.description !== undefined) reference.description = String(input.description).trim();
            if (input.contentJson !== undefined) {
                reference.contentJson = input.contentJson;
                reference.markModified("contentJson");
            }
            if (input.sourceLinks !== undefined)
                reference.sourceLinks = cleanSourceLinks(input.sourceLinks);
            reference.updatedBy = user._id;
            await reference.save();
            io.emit("auditReference:updated", reference.toObject());
            callback({ status: "success", message: "Audit reference saved", payload: reference.toObject() });
        } catch (error) {
            callback({ status: "error", message: error.code === 11000 ? "Badge code already exists" : error.message });
        }
    });

    socket.on("documentComments:get", async ({ documentId } = {}, responseCallback) => {
        const callback = safeCallback(responseCallback);
        try {
            const user = await requireUser(callback);
            if (!user || !requireAccess(user, "view", "document.article.view", callback)) return;
            if (!mongoose.isValidObjectId(documentId))
                return callback({ status: "error", message: "A valid document id is required" });
            const comments = await db.documentComment.find({ document: documentId })
                .sort({ status: 1, createdAt: -1 })
                .populate("createdBy", USER_SELECT)
                .populate("resolvedBy", USER_SELECT)
                .populate("replies.createdBy", USER_SELECT)
                .lean();
            callback({ status: "success", message: "Comments fetched", payload: comments });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on("documentComment:create", async (input = {}, responseCallback) => {
        const callback = safeCallback(responseCallback);
        try {
            const user = await requireUser(callback);
            if (!user || !requireAccess(user, "create", "document.comment.create", callback)) return;
            const body = String(input.body || "").trim();
            if (!mongoose.isValidObjectId(input.documentId) || !body)
                return callback({ status: "error", message: "Document and comment are required" });
            const comment = await db.documentComment.create({
                document: input.documentId,
                revision: input.revision,
                body,
                anchor: input.anchor,
                createdBy: user._id,
            });
            const payload = await db.documentComment.findById(comment._id)
                .populate("createdBy", USER_SELECT)
                .lean();
            io.emit("documentComment:created", payload);
            callback({ status: "success", message: "Comment added", payload });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on("documentComment:reply", async (input = {}, responseCallback) => {
        const callback = safeCallback(responseCallback);
        try {
            const user = await requireUser(callback);
            if (!user || !requireAccess(user, "create", "document.comment.create", callback)) return;
            const body = String(input.body || "").trim();
            if (!mongoose.isValidObjectId(input._id) || !body)
                return callback({ status: "error", message: "Comment and reply are required" });
            const comment = await db.documentComment.findById(input._id);
            if (!comment) return callback({ status: "error", message: "Comment not found" });
            comment.replies.push({ body, createdBy: user._id });
            await comment.save();
            const payload = await db.documentComment.findById(comment._id)
                .populate("createdBy", USER_SELECT)
                .populate("replies.createdBy", USER_SELECT)
                .lean();
            io.emit("documentComment:updated", payload);
            callback({ status: "success", message: "Reply added", payload });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on("documentComment:resolve", async ({ _id } = {}, responseCallback) => {
        const callback = safeCallback(responseCallback);
        try {
            const user = await requireUser(callback);
            if (!user || !requireAccess(user, "update", "document.comment.resolve", callback)) return;
            if (!mongoose.isValidObjectId(_id))
                return callback({ status: "error", message: "A valid comment id is required" });
            const comment = await db.documentComment.findById(_id);
            if (!comment) return callback({ status: "error", message: "Comment not found" });
            comment.status = "Resolved";
            comment.resolvedBy = user._id;
            comment.resolvedAt = new Date();
            await comment.save();
            const payload = await db.documentComment.findById(comment._id)
                .populate("createdBy", USER_SELECT)
                .populate("resolvedBy", USER_SELECT)
                .populate("replies.createdBy", USER_SELECT)
                .lean();
            io.emit("documentComment:updated", payload);
            callback({ status: "success", message: "Comment resolved", payload });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });
};
