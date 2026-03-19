const md5 = require("md5");
const db = require("../../models");

// Password hashing salt (must match frontend)
const PASSWORD_SALT = 'MANUFACTURING_EXECUTION_SYSTEM';

const MD5_PATTERN = /^[a-f0-9]{32}$/i;

const normalizeUserPayload = (payload = {}) => {
    const normalizedPayload = { ...payload };

    delete normalizedPayload.confirmPassword;

    if (typeof normalizedPayload.password === "string" && normalizedPayload.password.length > 0 && !MD5_PATTERN.test(normalizedPayload.password)) {
        normalizedPayload.password = md5(normalizedPayload.password + PASSWORD_SALT);
    }

    return normalizedPayload;
};

module.exports = (socket, io) => {
    socket.on("user:create", async (data, callback) => {
        try {
            await db.user.create(normalizeUserPayload(data));
            callback({ status: "success", message: "User created successfully" });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    })

    socket.on("user:update", async (payload, callback) => {
        try {
            const { _id, ...update } = payload;
            await db.user.updateOne({ _id }, { $set: normalizeUserPayload(update) });
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