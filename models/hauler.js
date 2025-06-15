const mongoose = require("mongoose");
const { io } = require("../socket/io");
const database = require("../config/database");

const haulerSchema = new mongoose.Schema({
    scac: { type: String },
    company: { type: String },
    trailerNumber: { type: String },
    loadNumber: { type: String },
    loadType: { type: String, enum: ["LTL", "FTL", "PTL"] },
    // Driver Info
    driverName: { type: String },
    driverPhone: { type: String },
    arrivalAt: { type: Date, default: Date.now },
    startLoadAt: { type: Date },
    finishLoadAt: { type: Date },
    assignedDock: { type: mongoose.Schema.Types.ObjectId, ref: "Dock" },
    priority: { type: String, enum: ["high", "normal", "low"], default: "normal" },
    notes: { type: String },
    status: { type: String, enum: ["pending", "loading", "unloading", "completed", "cancelled"], default: "pending" },
}, {
    timestamps: true,
})

module.exports = database.model("Hauler", haulerSchema, "hauler");