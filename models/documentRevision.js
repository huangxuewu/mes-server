const mongoose = require("mongoose");
const database = require("../config/database");

const pageMarginSchema = new mongoose.Schema({
    top: { type: Number, min: 0, max: 3, default: 0.75 },
    right: { type: Number, min: 0, max: 3, default: 0.75 },
    bottom: { type: Number, min: 0, max: 3, default: 0.75 },
    left: { type: Number, min: 0, max: 3, default: 0.75 },
}, { _id: false });

const documentPageSchema = new mongoose.Schema({
    size: { type: String, enum: ["LETTER", "A4", "LEGAL"], default: "LETTER" },
    margins: { type: pageMarginSchema, default: () => ({}) },
}, { _id: false });

const documentRevisionSchema = new mongoose.Schema({
    document: { type: mongoose.Schema.Types.ObjectId, ref: "Document", required: true },
    revision: { type: Number, required: true },
    title: { type: String, required: true },
    documentNumber: { type: String, default: "" },
    documentCategory: { type: String, default: "Other" },
    summary: { type: String, default: "" },
    contentJson: { type: mongoose.Schema.Types.Mixed, required: true },
    page: { type: documentPageSchema, default: () => ({}) },
    watermark: { type: String, default: "" },
    watermarkText: { type: String, default: "" },
    formSchema: { type: mongoose.Schema.Types.Mixed },
    relatedDocuments: [{
        document: { type: mongoose.Schema.Types.ObjectId, ref: "Document" },
        role: String,
        revision: Number,
        title: String,
        documentNumber: String,
    }],
    plainText: { type: String, default: "" },
    tags: [String],
    auditReferences: [{ type: mongoose.Schema.Types.ObjectId, ref: "AuditReference" }],
    effectiveAt: Date,
    reviewDueAt: Date,
    expiresAt: Date,
    expiryBehavior: String,
    changeSummary: { type: String, trim: true, default: "" },
    contentHash: { type: String, required: true },
    artifacts: [{
        format: { type: String, enum: ["docx", "pdf"] },
        url: String,
        storagePath: String,
        generatedAt: { type: Date, default: Date.now },
    }],
    publishedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    publishedAt: { type: Date, default: Date.now },
}, { timestamps: true, collection: "documentRevision" });

documentRevisionSchema.index({ document: 1, revision: 1 }, { unique: true });

module.exports = database.model("DocumentRevision", documentRevisionSchema, "documentRevision");
