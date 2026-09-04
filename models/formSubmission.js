const mongoose = require("mongoose");
const database = require("../config/database");

const answerSchema = new mongoose.Schema({
    fieldId: { type: String, required: true },
    value: mongoose.Schema.Types.Mixed,
}, { _id: false });

const artifactSchema = new mongoose.Schema({
    format: { type: String, enum: ["pdf"], default: "pdf" },
    url: String,
    storagePath: String,
    generatedAt: { type: Date, default: Date.now },
}, { _id: false });

const formSubmissionSchema = new mongoose.Schema({
    document: { type: mongoose.Schema.Types.ObjectId, ref: "Document", required: true },
    formRevision: { type: Number, required: true, min: 1 },
    entryNumber: { type: String, required: true, unique: true, trim: true },
    paperReference: { type: String, trim: true, default: "" },
    recordedAt: { type: Date, required: true },
    recordedBy: { type: String, trim: true, default: "" },
    shift: { type: String, trim: true, default: "" },
    status: { type: String, enum: ["Draft", "Submitted", "Corrected", "Void"], default: "Draft" },
    answers: [answerSchema],
    notes: { type: String, trim: true, default: "" },
    artifact: artifactSchema,
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    submittedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    submittedAt: Date,
}, { timestamps: true, collection: "formSubmission" });

formSubmissionSchema.index({ document: 1, recordedAt: -1 });
formSubmissionSchema.index({ document: 1, formRevision: 1, status: 1 });

module.exports = database.model("FormSubmission", formSubmissionSchema, "formSubmission");
