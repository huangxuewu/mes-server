const db = require("../../models");

module.exports = (socket, io) => {

    socket.on('product:create', async (payload, callback) => {
        try {
            const product = await db.product.create(payload);
            callback({ status: "success", message: "Product created successfully", payload: product })
        } catch (error) {
            callback({ status: "error", message: error.message })
        }
    });

    socket.on('product:update', async (payload, callback) => {
        try {
            const { _id, ...data } = payload;
            const product = await db.product.findByIdAndUpdate(_id, { $set: data }, { new: true });
            callback({ status: "success", message: "Product updated successfully", payload: product })
        } catch (error) {
            callback({ status: "error", message: error.message })
        }
    });

    socket.on('product:delete', async (payload, callback) => {
        try {
            const { _id } = payload;
            await db.product.findByIdAndDelete(_id);
            callback({ status: "success", message: "Product deleted successfully" })

        } catch (error) {
            callback({ status: "error", message: error.message })
        }
    });

    socket.on('product:get', async (query, callback) => {
        try {
            const product = await db.product.findOne(query);
            callback({ status: "success", message: "Product fetched successfully", payload: product })
        } catch (error) {
            callback({ status: "error", message: error.message })
        }
    });

    socket.on('product:fetch', async (query, callback) => {
        try {
            const products = await db.product.find(query);
            callback({ status: "success", message: "Products fetched successfully", payload: products })
        } catch (error) {
            callback({ status: "error", message: error.message })
        }
    });
}