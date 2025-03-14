const db = require("../../models");

module.exports = (socket, io) => {

    socket.on('product:create', async (data, callback) => {
        try {

        } catch (error) {
            callback({ status: "error", message: error.message })
        }
    });

    socket.on('product:update', async (data, callback) => {
        try {

        } catch (error) {
            callback({ status: "error", message: error.message })
        }
    });

    socket.on('product:delete', async (data, callback) => {
        try {

        } catch (error) {
            callback({ status: "error", message: error.message })
        }
    });

    socket.on('product:get', async (query, callback) => {
        try {
            db.product.findOne(query).then(product => {
                callback({ status: "success", message: "Product fetched successfully", payload: product })
            }).catch(error => {
                callback({ status: "error", message: error.message })
            })
        } catch (error) {
            callback({ status: "error", message: error.message })
        }
    });

    socket.on('products:get', async (query, callback) => {
        try {
            db.product.find(query).then(products => {
                callback({ status: "success", message: "Products fetched successfully", payload: products })
            }).catch(error => {
                callback({ status: "error", message: error.message })
            })
        } catch (error) {
            callback({ status: "error", message: error.message })
        }
    });
}