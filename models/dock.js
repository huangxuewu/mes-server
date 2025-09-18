const mongoose = require("mongoose");
const { io } = require("../socket/io");
const database = require("../config/database");

const dockSchema = new mongoose.Schema({
    name: { type: String, required: true },
    maintennance: {
        lastAt: { type: Date },
        nextAt: { type: Date },
        history: [{
            date: { type: Date, required: true },
            description: { type: String, required: true },
            contractor: { type: String, required: true },
            duration: { type: Number, required: true },
            notes: { type: String, required: true },
        }]
    },
    truck:{},
    status: {
        type: String,
        enum: ["Available", "Unavailable", "Maintenance", "Occupied"],
        default: "Available",
    }
});

const Dock = database.model("Dock", dockSchema, "dock");

Dock.watch([], { fullDocument: "updateLookup" })
    .on("change", (change) => {
        switch (change.operationType) {
            case "insert":
            case "update":
            case "replace":
                io.emit("dock:update", change.fullDocument);
                break;
                
            case "delete":
                io.emit("dock:delete", change.documentKey._id);
                break;
        }
    })

module.exports = Dock;