const db = require("../../models");

module.exports = (socket, io) => {
    socket.on("serviceProvider:fetch", async (query = {}, callback) => {
        try {
            const providers = await db.serviceProvider.find(query).sort({ vendor: 1, serviceType: 1 });
            callback({ status: "success", message: "Service providers fetched", payload: providers });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on("serviceProvider:get", async (query, callback) => {
        try {
            const provider = await db.serviceProvider.findOne(query);
            if (!provider) return callback({ status: "error", message: "Service provider not found" });
            callback({ status: "success", message: "Service provider fetched", payload: provider });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on("serviceProvider:create", async (data, callback) => {
        try {
            const provider = await db.serviceProvider.create(data);
            callback({ status: "success", message: "Service provider created", payload: provider });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on("serviceProvider:update", async ({ _id, ...data }, callback) => {
        try {
            const provider = await db.serviceProvider.findByIdAndUpdate(_id, { $set: data }, { new: true, runValidators: true });
            if (!provider) return callback({ status: "error", message: "Service provider not found" });
            callback({ status: "success", message: "Service provider updated", payload: provider });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on("serviceProvider:delete", async ({ _id }, callback) => {
        try {
            const result = await db.serviceProvider.deleteOne({ _id });
            if (!result.deletedCount) return callback({ status: "error", message: "Service provider not found" });
            callback({ status: "success", message: "Service provider deleted" });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });
};
