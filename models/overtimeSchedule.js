const mongoose = require("mongoose");
const { io } = require("../socket/io");
const database = require("../config/database");

const auditLogSchema = new mongoose.Schema({
    action: { type: String, enum: ["Created", "Updated", "Deleted", "Approved", "Rejected", "Requested"], required: true },
    by: { type: mongoose.Schema.Types.ObjectId, ref: "user", required: true },
    at: { type: Date, default: Date.now, required: true },
    changes: {
        before: { type: mongoose.Schema.Types.Mixed, default: null },
        after: { type: mongoose.Schema.Types.Mixed, default: null },
    },
    reason: { type: String, default: "" },
}, { _id: false });

const overtimeScheduleSchema = new mongoose.Schema({
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: "employee", required: true, index: true },
    workDate: { type: Date, required: true, index: true },

    type: { type: String, enum: ["Mandatory", "Optional", "Flexible", "EmployeeRequest"], required: true, index: true },
    status: { type: String, enum: ["Pending", "Approved", "Rejected", "Cancelled"], default: "Pending", required: true, index: true },

    requestedMinutes: { type: Number, min: 0, default: null },
    approvedMinutes: { type: Number, min: 0, default: null },
    allowedMinutesCap: { type: Number, min: 0, default: null },

    reasons: { type: [String], default: [] },

    auditLog: { type: [auditLogSchema], default: [] },

    scheduler: { type: mongoose.Schema.Types.ObjectId, ref: "user", default: null },
    schedulerAt: { type: Date, default: null },
}, { timestamps: true });

overtimeScheduleSchema.index({ employeeId: 1, workDate: 1 }, { unique: true });