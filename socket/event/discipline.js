const mongoose = require("mongoose");
const db = require("../../models");

const DRAFT_FIELDS = [
    "title", "notes", "performanceReviewId",
    "reviewPeriod", "reviewDate", "overallRating", "strengths", "areasForImprovement", "goals",
    "incidentDate", "severity", "description", "correctiveAction"
];

const pickDraftFields = (data) => {
    const next = {};
    for (const field of DRAFT_FIELDS)
        if (Object.prototype.hasOwnProperty.call(data, field))
            next[field] = data[field];
    return next;
};

const canTransition = (from, to) =>
    (from === "Draft" && to === "Issued")
    || (from === "Issued" && to === "Acknowledged");

module.exports = (socket, io) => {
    socket.on("disciplines:get", async ({ employeeId, type }, callback) => {
        try {
            if (!employeeId || !mongoose.isValidObjectId(employeeId))
                return callback({ status: "error", message: "Valid employee id is required" });

            const query = { employeeId };
            if (type) query.type = type;

            const records = await db.discipline
                .find(query)
                .sort({ createdAt: -1 })
                .populate("issuedBy", "displayName firstName lastName username")
                .populate("performanceReviewId", "title reviewPeriod reviewDate status");

            callback({ status: "success", message: "Discipline records fetched successfully", payload: records });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on("discipline:get", async ({ _id }, callback) => {
        try {
            if (!_id || !mongoose.isValidObjectId(_id))
                return callback({ status: "error", message: "Valid discipline id is required" });

            const record = await db.discipline
                .findById(_id)
                .populate("issuedBy", "displayName firstName lastName username")
                .populate("performanceReviewId", "title reviewPeriod reviewDate status areasForImprovement reviewDate");

            if (!record) return callback({ status: "error", message: "Discipline record not found" });

            callback({ status: "success", message: "Discipline record fetched successfully", payload: record });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on("discipline:create", async (data, callback) => {
        try {
            const { employeeId, type, title, performanceReviewId } = data;
            if (!employeeId || !mongoose.isValidObjectId(employeeId))
                return callback({ status: "error", message: "Valid employee id is required" });
            if (!type || !["PerformanceReview", "Discipline"].includes(type))
                return callback({ status: "error", message: "Valid discipline type is required" });
            if (!title?.trim())
                return callback({ status: "error", message: "Title is required" });

            const employee = await db.employee.findById(employeeId).lean();
            if (!employee) return callback({ status: "error", message: "Employee not found" });

            if (performanceReviewId) {
                const review = await db.discipline.findOne({
                    _id: performanceReviewId,
                    employeeId,
                    type: "PerformanceReview"
                }).lean();
                if (!review) return callback({ status: "error", message: "Linked performance review not found" });
            }

            const record = await db.discipline.create({
                employeeId,
                type,
                status: "Draft",
                title: title.trim(),
                performanceReviewId: performanceReviewId || null,
                ...pickDraftFields(data)
            });

            callback({ status: "success", message: "Discipline record created successfully", payload: record });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on("discipline:update", async ({ _id, status: nextStatus, issuedBy, ...data }, callback) => {
        try {
            if (!_id || !mongoose.isValidObjectId(_id))
                return callback({ status: "error", message: "Valid discipline id is required" });

            const existing = await db.discipline.findById(_id);
            if (!existing) return callback({ status: "error", message: "Discipline record not found" });

            if (nextStatus && nextStatus !== existing.status) {
                if (!canTransition(existing.status, nextStatus))
                    return callback({ status: "error", message: `Invalid status transition from ${existing.status} to ${nextStatus}` });

                if (nextStatus === "Issued") {
                    if (!issuedBy || !mongoose.isValidObjectId(issuedBy))
                        return callback({ status: "error", message: "Issuer is required to issue a record" });

                    existing.status = "Issued";
                    existing.issuedBy = issuedBy;
                    existing.issuedAt = new Date();
                }

                if (nextStatus === "Acknowledged") {
                    existing.status = "Acknowledged";
                    existing.acknowledgedAt = new Date();
                }

                await existing.save();
                await existing.populate("issuedBy", "displayName firstName lastName username");
                return callback({ status: "success", message: "Discipline record updated successfully", payload: existing });
            }

            if (existing.status !== "Draft")
                return callback({ status: "error", message: "Only draft records can be edited" });

            Object.assign(existing, pickDraftFields(data));
            if (data.title?.trim()) existing.title = data.title.trim();

            await existing.save();
            await existing.populate("issuedBy", "displayName firstName lastName username");
            callback({ status: "success", message: "Discipline record updated successfully", payload: existing });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on("discipline:delete", async ({ _id }, callback) => {
        try {
            if (!_id || !mongoose.isValidObjectId(_id))
                return callback({ status: "error", message: "Valid discipline id is required" });

            const existing = await db.discipline.findById(_id).lean();
            if (!existing) return callback({ status: "error", message: "Discipline record not found" });
            if (existing.status !== "Draft")
                return callback({ status: "error", message: "Only draft records can be deleted" });

            await db.discipline.deleteOne({ _id });
            callback({ status: "success", message: "Discipline record deleted successfully", payload: { _id } });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });
};
