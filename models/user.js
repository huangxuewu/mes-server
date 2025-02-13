const mongoose = require("mongoose");
const database = require("../config/database");

const userSchema = new mongoose.Schema({
    username: String,
    password: String,
    email: String,
    role: String,
    status: {
        type: String,
        enum: ["Active", "Inactive", "Disabled", "Deleted"],
        default: "Active"
    }
});

module.exports = database.model("user", userSchema, 'user');
