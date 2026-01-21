const mongoose = require("mongoose");
const { io } = require("../socket/io");
const database = require("../config/database");

const yardSchema = new mongoose.Schema({
    name: String,
    proNumber: {
        type: String,
        default: ""
    },
    loadNumber: {
        type: String,
        default: ""
    },
    scac: {
        type: String,
        default: ""
    },
    stage: {
        type: String,
        enum: ["Dropped", "Loaded", "WaitingPickup", "Parked", "Empty", "OutOfService", null],
        default: null
    },
    status: {
        type: String,
        enum: ["Available", "Occupied", "Reserved"],
        default: "Available"
    },
    items: [],
    parkedAt: { type: Date, default: null },
}, { timestamps: true });

const Yard = database.model("Yard", yardSchema, "yard");

Yard.watch([], { fullDocument: "updateLookup" })
    .on("change", (change) => {
        switch (change.operationType) {
            case "insert":
            case "update":
            case "replace":
                io.emit("yard:update", change.fullDocument);
                break;

            case "delete":
                io.emit("yard:delete", change.documentKey._id);
                break;
        }
    })


module.exports = Yard;