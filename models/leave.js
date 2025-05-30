const mongoose = require("mongoose");
const { io } = require("../socket/io");
const database = require("../config/database");

const leaveSchema = new mongoose.Schema({
    employee: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "employee",
        required: true
    },
    leaveType: {
        type: String,
        enum: ["Sick", "Vacation", "Unpaid"],
        required: true
    },
    startDate: {
        type: Date,
        required: true
    },
    endDate: {
        type: Date,
        required: true
    },
    status: {
        type: String,
        enum: ["Pending", "Approved", "Rejected"],
        default: "Pending"
    },
    reason: {
        type: String,
        required: true
    },
    approvedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "employee",
        default: null
    },
    approvedAt: {
        type: Date,
        default: null
    },
    isDeleted: {
        type: Boolean,
        default: false
    }
}, { timestamps: true });

module.exports = database.model("leave", leaveSchema, "leave");