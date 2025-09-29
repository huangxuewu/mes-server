const db = require("../../models");

module.exports = (socket, io) => {

    socket.on("announcement:create", async (data, callback) => {
        try {
            await db.announcement.create(data);
            callback({ status: "success", message: "Announcement created successfully" });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on("announcement:update", async ({ _id, ...data }, callback) => {
        try {
            await db.announcement.findByIdAndUpdate(_id, { $set: data }, { new: true });
            callback({ status: "success", message: "Announcement updated successfully" });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on("announcement:delete", async (_id, callback) => {
        try {
            await db.announcement.deleteOne({ _id });
            callback({ status: "success", message: "Announcement deleted successfully" });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on("announcement:get", async (data, callback) => {
        try {
            const announcement = await db.announcement.findOne(data);
            callback({ status: "success", message: "Announcement fetched successfully", payload: announcement });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on("announcements:get", async (data, callback) => {
        try {
            const announcements = await db.announcement.find(data);
            callback({ status: "success", message: "Announcements fetched successfully", payload: announcements });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });


};
