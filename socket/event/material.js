const db = require("../../models");

module.exports = (socket, io) => {

    socket.on('material:create', async (data, callback) => {
        try {
            const material = await db.material.create(data);
            callback({ status: "success", message: "Material created successfully", payload: material })
        } catch (error) {
            callback({ status: "error", message: error.message })
        }
    });

    socket.on('material:update', async (data, callback) => {
        try {
            const { _id, ...update } = data;
            const material = await db.material.findByIdAndUpdate(_id, { $set: update }, { new: true });
            callback({ status: "success", message: "Material updated successfully", payload: material })
        } catch (error) {
            callback({ status: "error", message: error.message })
        }
    });

    socket.on('material:delete', async (data, callback) => {
        try {
            await db.material.findByIdAndDelete(data._id);
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