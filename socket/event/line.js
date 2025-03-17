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
}