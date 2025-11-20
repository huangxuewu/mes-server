const db = require("../../models");

module.exports = (socket, io) => {

    socket.on("pallet:create", async (data, callback) => {
        try {
            const pallet = await db.pallet.create(data);
            callback({ status: "success", message: "Pallet created successfully", payload: pallet });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on("pallet:update", async (data, callback) => {
        try {
            const pallet = await db.pallet.findByIdAndUpdate(data._id, data, { new: true });
            callback({ status: "success", message: "Pallet updated successfully", payload: pallet });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on("pallet:delete", async (data, callback) => {
        try {
            await db.pallet.findByIdAndDelete(data._id);
            callback({ status: "success", message: "Pallet deleted successfully" });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on("pallet:get", async (data, callback) => {
        try {
            const pallet = await db.pallet.findById(data._id);
            callback({ status: "success", message: "Pallet fetched successfully", payload: pallet });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on("pallet:count", async (query, callback) => {
        try {
            const count = await db.pallet.countDocuments(query);
            callback({ status: "success", message: "Pallet count fetched successfully", payload: count });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

};