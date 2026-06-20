const mongoose = require("mongoose");
const database = require("../config/database");
const { io } = require("../socket/io");

const answerSchema = new mongoose.Schema({
    questionId: { type: String, required: true },
    sectionId: { type: String, required: true },
    rating: { type: Number, min: 1, max: 5 },
    note: { type: String, default: "" }
}, { _id: false });

const sectionScoreSchema = new mongoose.Schema({
    sectionId: { type: String, required: true },
    score: { type: Number },
    ratingBand: {
        type: String,
        enum: ["Outstanding", "Acceptable", "NeedsImprovement", "NonCompliant"]
    }
}, { _id: false });

const assessmentSchema = new mongoose.Schema({
    contactId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "contact",
        required: true
    },
    companyId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "contact",
        required: true
    },
    contactType: {
        type: String,
        enum: ["Vendor", "Supplier", "Contractor"],
        required: true
    },
    year: { type: Number, required: true },
    status: {
        type: String,
        enum: ["Draft", "Submitted"],
        default: "Draft"
    },
    answers: [answerSchema],
    sectionScores: [sectionScoreSchema],
    overallScore: { type: Number },
    ratingBand: {
        type: String,
        enum: ["Outstanding", "Acceptable", "NeedsImprovement", "NonCompliant"]
    },
    auditor: { type: String, default: "" },
    notes: { type: String, default: "" },
    submittedAt: { type: Date }
}, { timestamps: true });

assessmentSchema.index({ companyId: 1, year: 1, contactType: 1 }, { unique: true });

const Assessment = database.model("assessment", assessmentSchema, "assessment");

Assessment.watch([], { fullDocument: "updateLookup" })
    .on("change", (change) => {
        switch (change.operationType) {
            case "insert":
            case "update":
            case "replace":
                io.emit("assessment:update", change.fullDocument);
                break;
            case "delete":
                io.emit("assessment:delete", change.documentKey._id);
                break;
        }
    });

module.exports = Assessment;
