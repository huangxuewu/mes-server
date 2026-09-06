const mongoose = require("mongoose");
const { io } = require("../socket/io");
const database = require("../config/database");
const { deliverUserChange } = require('../socket/userDelivery');

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
        view: [String],
        update: [String],
        modify: [String],
        edit: [String],
        delete: [String],
        approve: [String],
        override: [String],
        export: [String],
        audit: [String],
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
                if (change.fullDocument) deliverUserChange(io, 'user:update', change.fullDocument).catch(error => console.error('User delivery failed:', error.message));
                break;
            case "delete":
                deliverUserChange(io, 'user:delete', change.documentKey._id).catch(error => console.error('User delivery failed:', error.message));
                break;
        }
    });

module.exports = User;
