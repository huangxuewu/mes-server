const db = require("../../models");

module.exports = (socket, io) => {


    socket.on("config:create", async (data, callback) => {
        try {
            const config = await db.config.create(data);
            callback({ status: "success", message: "Config created successfully", payload: config });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on("config:update", async (data, callback) => {
        try {
            console.log(data);
            const { key, ...update } = data;
            const config = await db.config.findOneAndUpdate({ key }, { $set: update }, { new: true });
            callback({ status: "success", message: "Config updated successfully", payload: config });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on("config:delete", async (data, callback) => {
        try {
            const config = await db.config.findByIdAndDelete(data._id);
            callback({ status: "success", message: "Config deleted successfully" });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on("config:get", async (data, callback) => {
        try {
            const config = await db.config.findOne(data);
            callback({ status: "success", message: "Config fetched successfully", payload: config });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on("config:fetch", async (query, callback) => {
        try {
            const config = await db.config.find(query);
            callback({ status: "success", message: "Config fetched successfully", payload: config });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on("station:get", async (query, callback) => {
        try {
            const station = await db.station.findOne(query);
            callback({ status: "success", message: "Station fetched successfully", payload: station });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on("station:create", async (data, callback) => {
        try {
            const station = await db.station.create(data);
            callback({ status: "success", message: "Station created successfully", payload: station });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on("station:update", async (payload, callback) => {
        try {
            const { _id, ...data } = payload;
            const station = await db.station.findByIdAndUpdate(_id, data, { new: true });
            callback({ status: "success", message: "Station updated successfully", payload: station });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

};
