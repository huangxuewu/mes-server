const mongoose = require("mongoose");
const { io } = require("../socket/io");
const database = require("../config/database");

const passcodeSchema = new mongoose.Schema({
    type: {
        type: String,
        enum: ["ACCOUNT", "PIN"],
        default: "ACCOUNT",
    },
    website: {
        type: String,
        default: "",
    },
    username: {
        type: String,
        default: "",
    },
    password: {
        type: String,
        default: "",
    },
    pin: {
        type: String,
        default: "",
    },
    note: {
        type: String,
        default: "",
    },
    visibility: {
        type: String,
        enum: ["PUBLIC", "PRIVATE"],
        default: "PUBLIC",
    }
});

const Passcode = database.model("Passcode", passcodeSchema, "passcode");

Passcode.watch([], { fullDocument: "updateLookup" })
    .on("change", (change) => {
        switch (change.operationType) {
            case "insert":
            case "update":
            case "replace":
                io.emit("passcode:update", change.fullDocument);
                break;
            case "delete":
                io.emit("passcode:delete", change.documentKey._id);
                break;
        }
    });

module.exports = Passcode;