const dayjs = require("dayjs");
const mongoose = require("mongoose");
const { io } = require("../socket/io");
const database = require("../config/database");

const haulerSchema = new mongoose.Schema({
    date: { type: String, default: dayjs().format("YYYY-MM-DD") },
    scac: { type: String },
    company: { type: String },
    seal: { type: String },
    trailer: { type: String },
    loadNumber: { type: String },
    loadType: { type: String, enum: ["","LTL", "FTL", "PTL"] },
    // Driver Info
    driverName: { type: String },
    contactNumber: { type: String },
    arrivedAt: { type: Date, default: Date.now },
    parkedAt: { type: Date },
    startLoadAt: { type: Date },
    finishLoadAt: { type: Date },
    assignedGate: { type: mongoose.Schema.Types.ObjectId, ref: "Gate" },
    priority: { type: String, enum: ["High", "Normal", "Low"], default: "Normal" },
    status: { type: String, enum: ["Available", "Loading", "Unloading", "Completed", "Cancelled"], default: "Available" },
    note: { type: String },
}, {
    timestamps: true,
})

const Hauler = database.model("Hauler", haulerSchema, "hauler");

Hauler.watch([], { fullDocument: "updateLookup" })
    .on("change", (change) => {
        switch (change.operationType) {
            case "update":
            case "replace":
                io.emit("hauler:update", change.fullDocument);
                break;

            case "delete":
                io.emit("hauler:delete", change.documentKey._id);
                break;
        }
    })

module.exports = Hauler;