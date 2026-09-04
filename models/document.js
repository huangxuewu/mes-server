const mongoose = require("mongoose");
const database = require("../config/database");

const editorDocumentDefault = () => ({
    type: "doc",
    content: [{ type: "paragraph" }],
});

const thumbnailSchema = new mongoose.Schema({
    kind: {
        type: String,
        enum: ["generated", "uploaded", "none"],
        default: "generated",
    },
    url: String,
    storagePath: String,
    updatedAt: Date,
}, { _id: false });

const attachmentSchema = new mongoose.Schema({
    name: { type: String, required: true },
    mimeType: String,
    size: Number,
    url: String,
    storagePath: String,
    uploadedAt: { type: Date, default: Date.now },
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
}, { _id: true });

const documentSchema = new mongoose.Schema({
    title: { type: String, required: true, trim: true },
    documentNumber: { type: String, trim: true, default: "" },
    summary: { type: String, trim: true, default: "" },
    type: { type: String, enum: ["article", "uploaded-file"], default: "article" },
    folder: { type: String, trim: true, default: "General" },
    tags: [{ type: String, trim: true }],
    auditReferences: [{ type: mongoose.Schema.Types.ObjectId, ref: "AuditReference" }],
    status: {
        type: String,
        enum: ["Draft", "In Review", "Published", "Review Overdue", "Expired", "Archived"],
        default: "Draft",
    },
    contentJson: { type: mongoose.Schema.Types.Mixed, default: editorDocumentDefault },
    plainText: { type: String, default: "" },
    yjsState: { type: Buffer, select: false },
    schemaVersion: { type: Number, default: 1 },
    owner: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    thumbnail: { type: thumbnailSchema, default: () => ({ kind: "generated" }) },
    attachments: [attachmentSchema],
    isTemplate: { type: Boolean, default: false },
    templateKey: { type: String, trim: true },
    systemManaged: { type: Boolean, default: false },
    templateVersion: { type: Number, default: 1 },
    reviewIntervalMonths: { type: Number, min: 1, max: 120, default: 12 },
    effectiveAt: Date,
    reviewDueAt: Date,
    expiresAt: Date,
    expiryBehavior: { type: String, enum: ["Warn", "Deactivate"], default: "Warn" },
    currentRevision: { type: Number, default: 0 },
    publishedAt: Date,
}, { timestamps: true, collection: "document" });

documentSchema.index({ title: "text", documentNumber: "text", summary: "text", plainText: "text" });
documentSchema.index({ status: 1, isTemplate: 1, updatedAt: -1 });
documentSchema.index({ auditReferences: 1 });
documentSchema.index({ templateKey: 1 }, { unique: true, sparse: true });

module.exports = database.model("Document", documentSchema, "document");
