const mongoose = require("mongoose");
const { io } = require("../socket/io");
const database = require("../config/database");

const gateSchema = new mongoose.Schema({
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
    truck: {},
    status: {
        type: String,
        enum: ["Available", "Unavailable", "Maintenance", "Occupied"],
        default: "Available",
    }
});

const Gate = database.model("Gate", gateSchema, "gate");

Gate.watch([], { fullDocument: "updateLookup" })
    .on("change", (change) => {
        switch (change.operationType) {
            case "insert":
            case "update":
            case "replace":
                io.emit("gate:update", change.fullDocument);
                break;

            case "delete":
                io.emit("gate:delete", change.documentKey._id);
                break;
        }
    })

module.exports = Gate;