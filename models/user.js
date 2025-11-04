const mongoose = require("mongoose");
const { io } = require("../socket/io");
const database = require("../config/database");

const userSchema = new mongoose.Schema({
    displayName: String,
    username: String,
    password: String,
    portrait: String,
    phone: String,
    email: String,
    role: String,
    status: {
        type: String,
        enum: ["Active", "Inactive", "Disabled", "Deleted"],
        default: "Active"
    },
    permission: {
        module: [String],
        access: [String],
        create: [String],
        update: [String],
        remove: [String],
        view: [String],
    },
    group: {
        type: String,
        description: "Group of users"
    }
});

const User = database.model("User", userSchema, "user");

User.watch([], { fullDocument: "updateLookup" })
    .on("change", (change) => {
        switch (change.operationType) {
            case "insert":
            case "update":
            case "replace":
                io.emit("user:update", change.fullDocument);
                break;
            case "delete":
                io.emit("user:delete", change.documentKey._id);
                break;
        }
    });

module.exports = User;
