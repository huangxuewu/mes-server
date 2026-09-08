const mongoose = require("mongoose");
const { io } = require("../socket/io");
const database = require("../config/database");



const stepsSchema = new mongoose.Schema({
    sequence: Number,
    name: String,
    stage: String,
    description: String,
    documents: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'document'
    }],
    machines: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'machine'
    }],
    tools: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'tools'
    }],
    qualifiedWorkers: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'employee'
    }],
    // Missing mainWorkers means this step still uses the legacy roster.
    mainWorkers: { type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'employee' }], default: undefined },
    backupWorkers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'employee' }],
});

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
    pictures: {
        floorPlan: String,          // floor plan picture of the line
        overview: String,           // overview picture of the line
        closeUp: String,            // close up picture of the line
        birdEye: String,            // bird eye view picture of the line
        layout: String,             // layout picture of the line
        crews: String,              // crews picture of the line
        schematicDiagram: String,   // schematic diagram picture of the line
    },
    location: String,
    efficiencyRate: {
        type: Number,
        default: 85
    },
    products: [],                       // products that can be produced on this line
    steps: [stepsSchema],               // steps to produce a product
    maintenanceSchedule: [],            // maintenance schedule for this line
    status: {
        code: Number,
        updatedAt: Date
    },
    productionRevision: { type: Number, default: 0 },
})

const Line = database.model("line", lineSchema, "line");

Line.watch([], { fullDocument: "updateLookup" })
    .on("change", (change) => {
        switch (change.operationType) {
            case "insert":
            case "update":
            case "replace":
                io.except('data-sync:lines').emit("line:update", change.fullDocument);
                break;
            case "delete":
                io.except('data-sync:lines').emit("line:delete", change.documentKey._id);
                break;
        }
    })

module.exports = Line;


