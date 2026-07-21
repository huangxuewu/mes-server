const db = require("../../models");
const dayjs = require("../../utils/dayjs");

module.exports = (socket) => {
    socket.on("visitor:register", async (payload = {}, callback) => {
        try {
            const visitorName = (payload.visitorName || "").trim();
            const companyName = (payload.companyName || "").trim();
            if (!payload.hostId) return callback({ status: "error", message: "Host is required" });
            if (!visitorName) return callback({ status: "error", message: "Visitor name is required" });
            if (!companyName) return callback({ status: "error", message: "Company name is required" });

            const visit = await db.visitor.create({
                hostId: payload.hostId,
                hostName: payload.hostName || "",
                hostPosition: payload.hostPosition || "",
                visitorName,
                companyName,
                photo: null,
                signInTime: payload.signInTime ? new Date(payload.signInTime) : new Date(),
                signOutTime: null,
            });

            callback({ status: "success", message: "Visitor registered successfully", payload: visit });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on("visitor:update", async ({ _id, ...data } = {}, callback) => {
        try {
            if (!_id) return callback({ status: "error", message: "Visitor id is required" });
            const visit = await db.visitor.findByIdAndUpdate(_id, { $set: data }, { new: true, runValidators: true });
            if (!visit) return callback({ status: "error", message: "Visitor not found" });
            callback({ status: "success", message: "Visitor updated successfully", payload: visit });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on("visitors:active", async (_query, callback) => {
        try {
            const timeZone = await dayjs.getFactoryTimeZone();
            const today = dayjs().tz(timeZone);
            const start = today.startOf("day").toDate();
            const end = today.add(1, "day").startOf("day").toDate();
            const visitors = await db.visitor
                .find({ signOutTime: null, signInTime: { $gte: start, $lt: end } })
                .sort({ signInTime: -1 })
                .lean();
            callback({ status: "success", message: "Active visitors fetched", payload: visitors });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on("visitor:signout", async ({ _id } = {}, callback) => {
        try {
            if (!_id) return callback({ status: "error", message: "Visitor id is required" });

            const visit = await db.visitor.findOneAndUpdate(
                { _id, signOutTime: null },
                { $set: { signOutTime: new Date() } },
                { new: true }
            );

            if (!visit) return callback({ status: "error", message: "Active visitor not found" });
            callback({ status: "success", message: "Visitor signed out successfully", payload: visit });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });
};
