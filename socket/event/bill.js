const db = require("../../models");

module.exports = (socket, io) => {
    socket.on("bill:fetch", async (query = {}, callback) => {
        try {
            const bills = await db.bill.find(query).sort({ periodStart: -1, provider: 1 });
            callback({ status: "success", message: "Bills fetched", payload: bills });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on("bill:get", async (query, callback) => {
        try {
            const bill = await db.bill.findOne(query);
            if (!bill) return callback({ status: "error", message: "Bill not found" });
            callback({ status: "success", message: "Bill fetched", payload: bill });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on("bill:create", async (data, callback) => {
        try {
            const bill = await db.bill.create(data);
            callback({ status: "success", message: "Bill created", payload: bill });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on("bill:update", async ({ _id, ...data }, callback) => {
        try {
            const bill = await db.bill.findByIdAndUpdate(_id, { $set: data }, { new: true, runValidators: true });
            if (!bill) return callback({ status: "error", message: "Bill not found" });
            callback({ status: "success", message: "Bill updated", payload: bill });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on("bill:delete", async ({ _id }, callback) => {
        try {
            const result = await db.bill.deleteOne({ _id });
            if (!result.deletedCount) return callback({ status: "error", message: "Bill not found" });
            callback({ status: "success", message: "Bill deleted" });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });
};
