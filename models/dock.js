const mongoose = require("mongoose");
const { io } = require("../socket/io");
const database = require("../config/database");

const dockSchema = new mongoose.Schema({
    alias: { type: String, required: true },
    position: {
        x: { type: Number, required: true },
        y: { type: Number, required: true },
        z: { type: Number, required: true },
        scale: { type: Number, required: true },
        facing: { type: String, required: true, enum: ["north", "south", "east", "west"] },
        rotation: { type: Number, required: true },
    },
    maintenance: {
        lastMaintenance: { type: Date },
        nextMaintenance: { type: Date },
        maintenanceHistory: [{
            date: { type: Date, required: true },
            description: { type: String, required: true },
            contractor: { type: String, required: true },
            duration: { type: Number, required: true },
            cost: { type: Number, required: true },
            notes: { type: String, required: true },
        }]
    },
    status: {
        type: String,
        enum: ["active", "inactive", "maintenance"],
    },
})

module.exports = database.model("Dock", dockSchema, "dock");