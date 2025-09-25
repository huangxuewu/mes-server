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
        access: [String],
        create: [String],
        update: [String],
        remove: [String],
        view: [String],
    }
});

module.exports = database.model("user", userSchema, 'user');
