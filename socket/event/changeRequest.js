const db = require("../../models");
const { getSessionUserId, hasPermission } = require("../session");
const { getHandler } = require("../../utils/changeRequestHandlers");

const USER_SELECT = "username displayName firstName lastName";

const actorId = (user) => String(user._id);

module.exports = (socket) => {
    const requireUser = async (callback) => {
        const userId = getSessionUserId(socket);
        if (!userId) {
            callback({ status: "error", message: "Not authenticated" });
            return null;
        }
        const user = await db.user.findById(userId).lean();
        if (!user) {
            callback({ status: "error", message: "User not found" });
            return null;
        }
        return user;
    };

    const requirePerm = (user, perm, callback, message) => {
        if (hasPermission(user, perm.action, perm.resource)) return true;
        callback({ status: "error", message });
        return false;
    };

    socket.on("changeRequest:submit", async (data = {}, callback) => {
        try {
            const user = await requireUser(callback);
            if (!user) return;

            const { referenceId, targetField, afterValue, reason } = data;
            if (!referenceId) return callback({ status: "error", message: "referenceId is required" });
            if (!targetField) return callback({ status: "error", message: "targetField is required" });
            if (!String(reason || "").trim())
                return callback({ status: "error", message: "Reason is required" });

            const handler = getHandler(targetField);
            if (!requirePerm(user, handler.submitPermission, callback, "You do not have permission to submit this change"))
                return;

            const { beforeValue, baseHash } = await handler.captureBefore(referenceId);
            const sanitized = handler.sanitizeAfter(afterValue);
            if (!handler.hasMeaningfulDiff(beforeValue, sanitized))
                return callback({ status: "error", message: "No changes to submit" });

            const existing = await db.changeRequest.findOne({
                referenceId,
                targetField,
                status: "Pending",
            }).lean();
            if (existing)
                return callback({ status: "error", message: "A pending change already exists for this record" });

            const doc = await db.changeRequest.create({
                referenceId,
                targetField,
                beforeValue,
                afterValue: sanitized,
                reason: String(reason).trim(),
                status: "Pending",
                submittedBy: user._id,
                submittedAt: new Date(),
                baseHash,
            });

            const payload = await db.changeRequest.findById(doc._id)
                .populate("submittedBy", USER_SELECT)
                .populate("verdictBy", USER_SELECT)
                .lean();

            callback({ status: "success", message: "Change request submitted", payload });
        } catch (error) {
            if (error?.code === 11000)
                return callback({ status: "error", message: "A pending change already exists for this record" });
            callback({ status: "error", message: error.message });
        }
    });

    socket.on("changeRequests:get", async (query = {}, callback) => {
        try {
            const user = await requireUser(callback);
            if (!user) return;

            const filter = {};
            if (query.status) filter.status = query.status;
            if (query.referenceId) filter.referenceId = query.referenceId;
            if (query.targetField) filter.targetField = query.targetField;
            if (Array.isArray(query.targetFields) && query.targetFields.length)
                filter.targetField = { $in: query.targetFields };

            const list = await db.changeRequest.find(filter)
                .sort({ submittedAt: -1 })
                .populate("submittedBy", USER_SELECT)
                .populate("verdictBy", USER_SELECT)
                .lean();

            callback({ status: "success", message: "Change requests fetched", payload: list });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on("changeRequest:approve", async (data = {}, callback) => {
        try {
            const user = await requireUser(callback);
            if (!user) return;

            const { _id, force = false, verdictNote = "" } = data;
            if (!_id) return callback({ status: "error", message: "Change request id is required" });

            const request = await db.changeRequest.findById(_id);
            if (!request) return callback({ status: "error", message: "Change request not found" });
            if (request.status !== "Pending")
                return callback({ status: "error", message: "Change request is not pending" });
            if (actorId(user) === String(request.submittedBy) && user.role !== "System" && user.role !== "Admin")
                return callback({ status: "error", message: "You cannot approve your own change request" });

            const handler = getHandler(request.targetField);
            if (!requirePerm(user, handler.approvePermission, callback, "You do not have permission to approve this change"))
                return;

            const { conflict, liveHash, liveValue } = await handler.checkConflict(
                request.referenceId,
                request.baseHash,
                request.beforeValue,
            );
            if (conflict && !force) {
                return callback({
                    status: "error",
                    message: "Record changed since submit",
                    payload: {
                        conflict: true,
                        liveValue,
                        afterValue: request.afterValue,
                        liveHash,
                        baseHash: request.baseHash,
                    },
                });
            }

            await handler.apply({
                referenceId: request.referenceId,
                beforeValue: request.beforeValue,
                afterValue: request.afterValue,
                reason: request.reason,
                submittedBy: request.submittedBy,
            });

            request.status = "Approved";
            request.verdictBy = user._id;
            request.verdictAt = new Date();
            request.verdictNote = String(verdictNote || "").trim();
            await request.save();

            const payload = await db.changeRequest.findById(request._id)
                .populate("submittedBy", USER_SELECT)
                .populate("verdictBy", USER_SELECT)
                .lean();

            callback({ status: "success", message: "Change request approved", payload });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on("changeRequest:reject", async (data = {}, callback) => {
        try {
            const user = await requireUser(callback);
            if (!user) return;

            const { _id, verdictNote = "" } = data;
            if (!_id) return callback({ status: "error", message: "Change request id is required" });
            if (!String(verdictNote || "").trim())
                return callback({ status: "error", message: "Rejection note is required" });

            const request = await db.changeRequest.findById(_id);
            if (!request) return callback({ status: "error", message: "Change request not found" });
            if (request.status !== "Pending")
                return callback({ status: "error", message: "Change request is not pending" });
            if (actorId(user) === String(request.submittedBy) && user.role !== "System" && user.role !== "Admin")
                return callback({ status: "error", message: "You cannot reject your own change request" });

            const handler = getHandler(request.targetField);
            if (!requirePerm(user, handler.approvePermission, callback, "You do not have permission to reject this change"))
                return;

            request.status = "Rejected";
            request.verdictBy = user._id;
            request.verdictAt = new Date();
            request.verdictNote = String(verdictNote).trim();
            await request.save();

            const payload = await db.changeRequest.findById(request._id)
                .populate("submittedBy", USER_SELECT)
                .populate("verdictBy", USER_SELECT)
                .lean();

            callback({ status: "success", message: "Change request rejected", payload });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on("changeRequest:cancel", async (data = {}, callback) => {
        try {
            const user = await requireUser(callback);
            if (!user) return;

            const { _id } = data;
            if (!_id) return callback({ status: "error", message: "Change request id is required" });

            const request = await db.changeRequest.findById(_id);
            if (!request) return callback({ status: "error", message: "Change request not found" });
            if (request.status !== "Pending")
                return callback({ status: "error", message: "Change request is not pending" });
            if (actorId(user) !== String(request.submittedBy))
                return callback({ status: "error", message: "Only the submitter can cancel this change request" });

            request.status = "Cancelled";
            request.verdictBy = user._id;
            request.verdictAt = new Date();
            request.verdictNote = "Cancelled by submitter";
            await request.save();

            const payload = await db.changeRequest.findById(request._id)
                .populate("submittedBy", USER_SELECT)
                .populate("verdictBy", USER_SELECT)
                .lean();

            callback({ status: "success", message: "Change request cancelled", payload });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });
};
