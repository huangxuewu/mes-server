const mongoose = require("mongoose");

const taskSchema = new mongoose.Schema({
    code: { type: String, default: '' },
    urgency: { type: String, default: 'NORMAL' },
    title: { type: String, default: '' },
    note: { type: String, default: '' },
    guideline: {
        suggestedStartMinute: { type: Number, default: null },
        suggestedEndMinute: { type: Number, default: null },
        estimateMinutes: { type: Number, default: null },
        capMinutes: { type: Number, default: null }
    },
    status: {
        type: String,
        enum: ['Draft', 'Pending', 'Approved', 'Rejected'],
        default: 'Pending'
    },
    completedAt: { type: Date, default: null }
});

const auditLogSchema = new mongoose.Schema({
    at: { type: Date, default: null },
    by: { type: mongoose.Schema.Types.Mixed, default: null },
    action: { type: String, default: null },
    from: { type: String, default: null },
    to: { type: String, default: null },
    note: { type: String, default: '' }
});

const overtimeSchema = new mongoose.Schema({
    employeeId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'employee',
        required: true
    },
    date: {
        type: String,
        required: true
    },
    allowedOvertimeMinutes: { type: Number, default: 0 },
    type: {
        type: String,
        enum: ['Mandatory', 'Optional', 'Request'],
        default: 'Optional'
    },
    status: {
        type: String,
        enum: ['Draft', 'Pending', 'Approved', 'Rejected'],
        default: 'Draft'
    },
    tasks: [taskSchema],
    auditLog: [auditLogSchema]
}, { timestamps: true });

// One overtime schedule per employee per day
overtimeSchema.index({ employeeId: 1, date: 1 }, { unique: true });

module.exports = mongoose.model('overtime', overtimeSchema);
