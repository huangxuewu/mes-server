const mongoose = require("mongoose");
const database = require("../config/database");

const disciplineSchema = new mongoose.Schema({
    employeeId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "employee",
        required: true,
        index: true
    },
    type: {
        type: String,
        enum: ["PerformanceReview", "Discipline"],
        required: true
    },
    status: {
        type: String,
        enum: ["Draft", "Issued", "Acknowledged"],
        default: "Draft"
    },
    title: { type: String, required: true, trim: true },
    notes: { type: String, default: "" },
    issuedBy: { type: mongoose.Schema.Types.ObjectId, ref: "user", default: null },
    issuedAt: { type: Date, default: null },
    acknowledgedAt: { type: Date, default: null },
    performanceReviewId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "discipline",
        default: null
    },
    dailyMetrics: [{
        date: { type: String },
        note: { type: String },
        rating: { type: Number, min: 1, max: 5, default: null }
    }],
    reviewPeriod: { type: String, default: "" },
    reviewDate: { type: String, default: "" },
    overallRating: { type: Number, min: 1, max: 5, default: null },
    strengths: { type: String, default: "" },
    areasForImprovement: { type: String, default: "" },
    goals: { type: String, default: "" },
    incidentDate: { type: String, default: "" },
    severity: {
        type: String,
        enum: ["Verbal", "Written", "Final", "Other", ""],
        default: ""
    },
    description: { type: String, default: "" },
    correctiveAction: { type: String, default: "" }
}, { timestamps: true });

disciplineSchema.index({ employeeId: 1, createdAt: -1 });

module.exports = database.model("discipline", disciplineSchema, "discipline");
