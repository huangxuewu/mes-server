const db = require("../../models");

module.exports = (socket, io) => {

    socket.on("inventory:list", async (query, callback) => {
        try {
            const inventory = await db.inventory.find(query);
            callback({ status: "success", message: "Inventory fetched successfully", payload: inventory });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    })

    socket.on("inventory:create", async (data, callback) => { })
    socket.on("inventory:update", async (data, callback) => { })
    socket.on("inventory:delete", async (data, callback) => { })
    socket.on("inventory:get-all", async (data, callback) => { })
}