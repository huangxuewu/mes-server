const mongoose = require("mongoose");
const database = require("../config/database");
const { io } = require("../socket/io");

const positionSchema = new mongoose.Schema({
    title: {
        type: String,
        required: true
    },
    description: String,
    index: {
        type: Number,
        default: 0,
        description: "Index for sorting"
    },
    department: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'department',
        required: true
    },
    level: {
        type: String,
        enum: ["Intern", "Junior", "Intermediate", "Senior", "Lead", "Supervisor", "Manager", "Director", "Executive", "Custom"],
        default: "Junior"
    },
    salaryRange: {
        min: { type: Number, min: 0 },
        max: { type: Number, min: 0 }
    },
    reportsTo: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'position'
    },
    jobDescription: String,
    requirements: [String],
    responsibilities: [String],
    employmentType: {
        type: String,
        enum: ["Full Time", "Part Time", "Contract", "Intern"],
        default: "Full Time"
    },
    workType: {
        type: String,
        enum: ["On Site", "Remote"],
        default: "On Site"
    },
    probationPeriod: {
        type: Number,
        default: 12,
        description: "Probation period in weeks"
    },
    status: {
        type: String,
        enum: ["Active", "Inactive"],
        default: "Active"
    },
    isHiring: {
        type: Boolean,
        default: false
    },
    index: {
        type: Number,
        default: 0,
        description: "Index for sorting"
    }
}, {
    timestamps: true
});

const Position = database.model("position", positionSchema, 'position');

/**
 * Change stream to emit via socket.io
 */
Position.watch([], { fullDocument: "updateLookup" })
    .on("change", (change) => {
        switch (change.operationType) {
            case "insert":
            case "update":
            case "replace":
                io.emit("position:update", change.fullDocument);
                break;
            case "delete":
                io.emit("position:delete", change.documentKey._id);
                break;
        }
    });

module.exports = Position;
