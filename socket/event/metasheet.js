const db = require("../../models");

module.exports = (socket, io) => {
    socket.on("metasheet:create", async (data, callback) => {
        try {
            const metasheet = await db.metasheets.create(data);
            callback({ status: "success", message: "Metasheet created successfully", payload: metasheet });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on("metasheet:update", async (data, callback) => {
        try {
            const { _id, ...update } = data;
            const metasheet = await db.metasheets.findByIdAndUpdate(_id, { $set: update }, { new: true });
            callback({ status: "success", message: "Metasheet updated successfully", payload: metasheet });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on("metasheet:delete", async (_id, callback) => {
        try {
            await db.metasheets.findByIdAndDelete(_id);
            callback({ status: "success", message: "Metasheet deleted successfully" });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    // for multiple document
    socket.on("metasheet:fetch", async (query = {}, callback) => {
        try {
            const metasheets = await db.metasheets.find(query);
            callback({ status: "success", message: "Metasheets fetched successfully", payload: metasheets });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    // for single document
    socket.on("metasheet:get", async (query, callback) => {
        try {
            const metasheet = await db.metasheets.findOne(query);
            callback({ status: "success", message: "Metasheet fetched successfully", payload: metasheet });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });
}