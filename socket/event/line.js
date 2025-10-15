const db = require("../../models");

module.exports = (socket, io) => {
    socket.on('line:create', async (data, callback) => {
        try {

        } catch (error) {
            callback({ status: "error", message: error.message })
        }
    })

    socket.on('line:update', async (data, callback) => {
        try {

        } catch (error) {
            callback({ status: "error", message: error.message })
        }
    })

    socket.on('line:delete', async (data, callback) => {
        try {

        } catch (error) {
            callback({ status: "error", message: error.message })
        }
    })

    socket.on('line:get', async (query, callback) => {
        try {

        } catch (error) {
            callback({ status: "error", message: error.message })
        }
    })

    socket.on('lines:get', async (query, callback) => {
        try {
            db.line.find(query).then(lines => {
                callback({ status: "success", message: "Lines fetched successfully", payload: lines })
            }).catch(error => {
                callback({ status: "error", message: error.message })
            })
        } catch (error) {
            callback({ status: "error", message: error.message })
        }
    })

    socket.on('parameter:create', async (data, callback) => {
        try {
            const parameter = await db.parameter.create(data);
            callback({ status: "success", message: "Parameter created successfully", payload: parameter })
        } catch (error) {
            callback({ status: "error", message: error.message })
        }
    })

    socket.on('parameter:update', async (data, callback) => {
        try {
            const parameter = await db.parameter.updateOne({ _id: data._id }, { $set: data });
            callback({ status: "success", message: "Parameter updated successfully", payload: parameter })
        } catch (error) {
            callback({ status: "error", message: error.message })
        }
    })

    socket.on('parameter:delete', async (data, callback) => {
        try {
            const parameter = await db.parameter.deleteOne({ _id: data._id });
            callback({ status: "success", message: "Parameter deleted successfully", payload: parameter })
        } catch (error) {
            callback({ status: "error", message: error.message })
        }
    })

    socket.on('parameter:get', async (data, callback) => {
        try {
            const parameter = await db.parameter.findOne({ _id: data._id });
            callback({ status: "success", message: "Parameter fetched successfully", payload: parameter })
        } catch (error) {
            callback({ status: "error", message: error.message })
        }
    })

    socket.on('parameters:get', async (data = {}, callback) => {
        try {
            const parameter = await db.parameter.find(data);
            callback({ status: "success", message: "Parameter fetched successfully", payload: parameter })
        } catch (error) {
            callback({ status: "error", message: error.message })
        }
    })
}