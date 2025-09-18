const db = require("../../models");

module.exports = (socket, io) => {

    socket.on("topic:create", async (data, callback) => {
        try {
            await db.topic.create(data);
            callback({ status: "success", message: "Topic created successfully" });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on("topic:update", async (data, callback) => {

        try {
            await db.topic.updateOne({ _id: data._id }, { $set: data });
            callback({ status: "success", message: "Topic updated successfully" });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on("topic:delete", async (data, callback) => {
        try {
            await db.topic.deleteOne({ _id: data._id });
            callback({ status: "success", message: "Topic deleted successfully" });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on("topic:get", async (data, callback) => {

        try {
            const topic = await db.topic.findOne({ _id: data._id });
            callback({ status: "success", message: "Topic fetched successfully", payload: topic });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on("topics:get", async (data, callback) => {

        try {
            const topics = await db.topic.find(data);
            callback({ status: "success", message: "Topics fetched successfully", payload: topics });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on("message:create", async (data, callback) => {
        try {
            await db.message.create(data);
            callback({ status: "success", message: "Message created successfully" });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on("message:edit", async (data, callback) => {
        try {
            await db.message.updateOne({ _id: data._id }, { $set: data });
            callback({ status: "success", message: "Message updated successfully" });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on("message:retract", async (data, callback) => {
        try {
            await db.message.updateOne({ _id: data._id }, { $set: { status: "Retracted" } });
            callback({ status: "success", message: "Message retracted successfully" });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on("message:restore", async (data, callback) => {
        try {
            await db.message.updateOne({ _id: data._id }, { $set: { status: "Active" } });
            callback({ status: "success", message: "Message restored successfully" });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });
}