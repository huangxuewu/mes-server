const db = require("../../models");

module.exports = (socket, io) => {
    socket.on("user:create", async (data, callback) => {
        try {
            await db.user.create(data);
            callback({ status: "success", message: "User created successfully" });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    })

    socket.on("user:update", async (data, callback) => {
        try {
            await db.user.updateOne({ _id: data._id }, { $set: data });
            callback({ status: "success", message: "User updated successfully" });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    })

    socket.on("user:delete", async (data, callback) => {
        try {
            await db.user.deleteOne({ _id: data._id });
            callback({ status: "success", message: "User deleted successfully" });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    })

    socket.on("user:get", async (data, callback) => {
        try {
            const user = await db.user.findOne({ _id: data._id });
            callback({ status: "success", message: "User fetched successfully", payload: user });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    })

    socket.on("users:get", async (data, callback) => {
        try {
            const users = await db.user.find(data);
            callback({ status: "success", message: "Users fetched successfully", payload: users });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    })
}