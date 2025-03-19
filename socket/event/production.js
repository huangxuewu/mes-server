const db = require("../../models");

module.exports = (socket, io) => {

    socket.on('lines:get', async (query, callback) => {
        try {
            const lines = await db.line.find(query);
            callback({ status: "success", message: "Production Lines fetched successfully", payload: lines });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

}