const db = require("../../models");
const { computeScores } = require("../../utils/assessmentScoring");

const resolveCompanyId = contact => contact.businessInfo?.companyId || contact._id;

module.exports = (socket, io) => {
    socket.on("assessments:fetch", async (query = {}, callback) => {
        try {
            const assessments = await db.assessment.find(query).sort({ year: -1, updatedAt: -1 });
            callback({ status: "success", message: "Assessments fetched", payload: assessments });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on("assessment:get", async (query, callback) => {
        try {
            const assessment = await db.assessment.findOne(query);
            if (!assessment) return callback({ status: "error", message: "Assessment not found" });
            callback({ status: "success", message: "Assessment fetched", payload: assessment });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on("assessment:create", async (data, callback) => {
        try {
            const contact = await db.contact.findById(data.contactId);
            if (!contact) return callback({ status: "error", message: "Contact not found" });

            const scores = computeScores(data.answers || []);
            const assessment = await db.assessment.create({
                contactId: data.contactId,
                companyId: resolveCompanyId(contact),
                contactType: data.contactType || contact.type,
                year: data.year,
                status: data.status || "Draft",
                answers: data.answers || [],
                auditor: data.auditor || "",
                notes: data.notes || "",
                submittedAt: data.status === "Submitted" ? new Date() : null,
                ...scores
            });

            callback({ status: "success", message: "Assessment created", payload: assessment });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on("assessment:update", async ({ _id, ...data }, callback) => {
        try {
            const existing = await db.assessment.findById(_id);
            if (!existing) return callback({ status: "error", message: "Assessment not found" });

            if (existing.status === "Submitted" && data.status !== "Draft")
                return callback({ status: "error", message: "Submitted assessments cannot be modified" });

            const answers = data.answers ?? existing.answers;
            const scores = computeScores(answers);
            const status = data.status ?? existing.status;

            const assessment = await db.assessment.findByIdAndUpdate(_id, {
                $set: {
                    answers,
                    auditor: data.auditor ?? existing.auditor,
                    notes: data.notes ?? existing.notes,
                    status,
                    submittedAt: status === "Submitted" ? (existing.submittedAt || new Date()) : null,
                    ...scores
                }
            }, { new: true, runValidators: true });

            callback({ status: "success", message: "Assessment updated", payload: assessment });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on("assessment:delete", async ({ _id }, callback) => {
        try {
            const result = await db.assessment.deleteOne({ _id });
            if (!result.deletedCount) return callback({ status: "error", message: "Assessment not found" });
            callback({ status: "success", message: "Assessment deleted" });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });
};
