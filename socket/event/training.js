const dayjs = require("dayjs");
const db = require("../../models");
const mongoose = require("mongoose");
const { Types: { ObjectId } } = mongoose;

module.exports = (socket, io) => {

    // training for actual production line

    socket.on("training:create", async (data, callback) => {
        try {
            await db.training.create(data);
            callback({ status: "success", message: "Training created successfully" });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on("training:update", async (data, callback) => {
        try {
            await db.training.updateOne({ _id: data._id }, { $set: data });
            callback({ status: "success", message: "Training updated successfully" });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on("training:delete", async (data, callback) => {
        try {
            await db.training.deleteOne({ _id: data._id });
            callback({ status: "success", message: "Training deleted successfully" });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on("training:get", async (data, callback) => {
        try {
            const training = await db.training.findOne({ _id: data._id });
            callback({ status: "success", message: "Training fetched successfully", payload: training });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on("training:complete", async (data, callback) => {
        try {
            await db.training.updateOne({ _id: data._id }, { $set: { completed: true } });
            callback({ status: "success", message: "Training completed successfully" });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    // tutorial for software training purpose

    socket.on("tutorials:get", async (data, callback) => {
        try {
            const tutorials = await db.tutorial.find(data);
            callback({ status: "success", message: "Tutorials fetched successfully", payload: tutorials });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on("tutorial:create", async (data, callback) => {
        try {
            await db.tutorial.create(data);
            callback({ status: "success", message: "Tutorial created successfully" });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on("tutorial:update", async (data, callback) => {
        try {
            await db.tutorial.updateOne({ _id: data._id }, { $set: data });
            callback({ status: "success", message: "Tutorial updated successfully" });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on("tutorial:delete", async (data, callback) => {
        try {
            await db.tutorial.deleteOne({ _id: data._id });
            callback({ status: "success", message: "Tutorial deleted successfully" });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });


}