const db = require("../../models");

module.exports = (socket, io) => {
    socket.on("invoice:fetch", async (query = {}, callback) => {
        try {
            const invoices = await db.invoice.find(query).sort({ periodStart: -1, provider: 1 });
            callback({ status: "success", message: "Invoices fetched", payload: invoices });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on("invoice:get", async (query, callback) => {
        try {
            const invoice = await db.invoice.findOne(query);
            if (!invoice) return callback({ status: "error", message: "Invoice not found" });
            callback({ status: "success", message: "Invoice fetched", payload: invoice });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on("invoice:create", async (data, callback) => {
        try {
            const invoice = await db.invoice.create(data);
            callback({ status: "success", message: "Invoice created", payload: invoice });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on("invoice:update", async ({ _id, ...data }, callback) => {
        try {
            const invoice = await db.invoice.findByIdAndUpdate(_id, { $set: data }, { new: true, runValidators: true });
            if (!invoice) return callback({ status: "error", message: "Invoice not found" });
            callback({ status: "success", message: "Invoice updated", payload: invoice });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on("invoice:delete", async ({ _id }, callback) => {
        try {
            const result = await db.invoice.deleteOne({ _id });
            if (!result.deletedCount) return callback({ status: "error", message: "Invoice not found" });
            callback({ status: "success", message: "Invoice deleted" });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });
};
