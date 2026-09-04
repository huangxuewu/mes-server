const mongoose = require("mongoose");
const database = require("../config/database");

const documentRevisionSchema = new mongoose.Schema({
    document: { type: mongoose.Schema.Types.ObjectId, ref: "Document", required: true },
    revision: { type: Number, required: true },
    title: { type: String, required: true },
    documentNumber: { type: String, default: "" },
    summary: { type: String, default: "" },
    contentJson: { type: mongoose.Schema.Types.Mixed, required: true },
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
