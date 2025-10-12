const mongoose = require("mongoose");
const { io } = require("../socket/io");
const database = require("../config/database");

const staffSchema = new mongoose.Schema({
    index: Number,
    position: String,
    // number of staffs required for this position
    // if manning is 0, it means the position is not required
    // if manning is 4 but only 2 staffs coming today, means only has 50% of the output capacity
    manning: Number,
    isSupportRole: Boolean,
    description: String,
    skills: []
})

// config for production line
const lineSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true
    },
    description: {
        type: String,
        required: true
    },
    picture: String,
    location: String,
    capacity: {}, // proudction capacity per hour
    efficiencyRate: {
        type: Number,
        default: 85
    },
    staffs: [staffSchema],
    products: [],             // products that can be produced on this line
    procedures: [],           // procedures that can be performed on this line
    maintenanceSchedule: [],  // maintenance schedule for this line
    status: {
        code: Number,
        updatedAt: Date
    },
})

const Line = database.model("line", lineSchema, "line");

Line.watch([], { fullDocument: "updateLookup" })
    .on("change", (change) => {
        switch (change.operationType) {
            case "insert":
            case "update":
            case "replace":
                io.emit("line:update", change.fullDocument);
                break;
            case "delete":
                io.emit("line:delete", change.documentKey._id);
                break;
        }
    })

module.exports = Line;


