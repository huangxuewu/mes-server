const db = require("../../models");

module.exports = (socket, io) => {

    socket.on('material:create', async (payload, callback) => {
        try {
            const material = await db.material.create(payload);
            callback({ status: "success", message: "Material created successfully", payload: material })
        } catch (error) {
            callback({ status: "error", message: error.message })
        }
    });

    socket.on('material:update', async (payload, callback) => {
        try {
            const { _id, ...update } = payload;
            const material = await db.material.findByIdAndUpdate(_id, { $set: update }, { new: true });
            callback({ status: "success", message: "Material updated successfully", payload: material })
        } catch (error) {
            callback({ status: "error", message: error.message })
        }
    });

    socket.on('material:delete', async (payload, callback) => {
        try {
            const { _id } = payload;
            await db.material.findByIdAndDelete(_id);
            callback({ status: "success", message: "Material deleted successfully" })
        } catch (error) {
            callback({ status: "error", message: error.message })
        }
    });

    socket.on('material:get', async (query, callback) => {
        try {
            const material = await db.material.findOne(query);
            callback({ status: "success", message: "Material fetched successfully", payload: material })
        } catch (error) {
            callback({ status: "error", message: error.message })
        }
    });

    socket.on('material:fetch', async (query = {}, callback) => {
        try {
            const materials = await db.material.find(query);
            callback({ status: "success", message: "Materials fetched successfully", payload: materials })
        } catch (error) {
            callback({ status: "error", message: error.message })
        }
    });
}