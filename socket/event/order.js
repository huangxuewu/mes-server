const db = require("../../models");

module.exports = (socket, io) => {

    socket.on('order:create', async (data, callback) => {
        try {
            const order = new db.order(data);
            // check if order po number already exists
            await order.checkDuplication();
            await order.save();

            callback({ status: "success", message: "Order created successfully", payload: order })
        } catch (error) {
            callback({ status: "error", message: error.message })
        }
    });

    socket.on('order:update', async (data, callback) => {
        try {

        } catch (error) {
            callback({ status: "error", message: error.message })
        }
    });

    socket.on('order:delete', async (data, callback) => {
        try {

        } catch (error) {
            callback({ status: "error", message: error.message })
        }
    });

    socket.on('order:get', async (data, callback) => {
        try {

        } catch (error) {
            callback({ status: "error", message: error.message })
        }
    });

    socket.on('orders:get', async (query, callback) => {
        try {
            db.order.find(query).sort({ cancelDate: 1 }).then(orders => {
                callback({ status: "success", message: "Orders fetched successfully", payload: orders })
            }).catch(error => {
                callback({ status: "error", message: error.message })
            })
        } catch (error) {
            callback({ status: "error", message: error.message })
        }
    });
}