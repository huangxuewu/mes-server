const mongoose = require("mongoose");
const database = require("../config/database");

const editorDocumentDefault = () => ({
    type: "doc",
    content: [{ type: "paragraph" }],
});

const pageMarginSchema = new mongoose.Schema({
    top: { type: Number, min: 0, max: 3, default: 0.75 },
    right: { type: Number, min: 0, max: 3, default: 0.75 },
    bottom: { type: Number, min: 0, max: 3, default: 0.75 },
    left: { type: Number, min: 0, max: 3, default: 0.75 },
}, { _id: false });

const documentPageSchema = new mongoose.Schema({
    companyName: { type: String, maxlength: 200, default: '' },
    companyLogo: { type: String, maxlength: 100000, default: '' },
    header: { type: require('../utils/documentPageBandSchema'), default: () => ({}) },
    footer: { type: require('../utils/documentPageBandSchema'), default: () => ({}) },
    size: { type: String, enum: ["LETTER", "A4", "LEGAL"], default: "LETTER" },
    margins: { type: pageMarginSchema, default: () => ({}) },
}, { _id: false });

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
    purpose: { type: String, enum: ["resource", "attachment"] },
    mimeType: String,
    size: Number,
    url: String,
    storagePath: String,
    uploadedAt: { type: Date, default: Date.now },
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
}, { _id: true });

const relatedDocumentSchema = new mongoose.Schema({
    document: { type: mongoose.Schema.Types.ObjectId, ref: "Document", required: true },
    role: { type: String, enum: ["SOP", "Reference"], default: "SOP" },
    revision: { type: Number, min: 1 },
    title: String,
    documentNumber: String,
}, { _id: false });

const documentSchema = new mongoose.Schema({
    title: { type: String, required: true, trim: true },
    documentNumber: { type: String, trim: true, default: "" },
    summary: { type: String, trim: true, default: "" },
    type: { type: String, enum: ["article", "form", "uploaded-file"], default: "article" },
    documentCategory: {
        type: String,
        enum: ["Policy", "Procedure", "Work Instruction", "Manual", "Form", "Plan", "Record", "Report", "Specification", "Guideline", "Other"],
        default: "Other",
    },
    folder: { type: String, trim: true, default: "General" },
    tags: [{ type: String, trim: true }],
    auditReferences: [{ type: mongoose.Schema.Types.ObjectId, ref: "AuditReference" }],
    status: {
        type: String,
        enum: ["Draft", "In Review", "Published", "Review Overdue", "Expired", "Archived"],
        default: "Draft",
    },
    contentJson: { type: mongoose.Schema.Types.Mixed, default: editorDocumentDefault },
    page: { type: documentPageSchema, default: () => ({}) },
    watermark: { type: String, enum: ["", "manufacturer", "confidential"], default: "" },
    watermarkText: { type: String, trim: true, default: "" },
    formSchema: { type: mongoose.Schema.Types.Mixed },
    relatedDocuments: [relatedDocumentSchema],
    plainText: { type: String, default: "" },
    yjsState: { type: Buffer, select: false },
    schemaVersion: { type: Number, default: 1 },
    owner: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    thumbnail: { type: thumbnailSchema, default: () => ({ kind: "generated" }) },
    attachments: [attachmentSchema],
    isTemplate: { type: Boolean, default: false },
    sourceTemplate: { type: mongoose.Schema.Types.ObjectId, ref: "Document" },
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
documentSchema.index({ sourceTemplate: 1, status: 1 });
documentSchema.index({ templateKey: 1 }, { unique: true, sparse: true });

module.exports = database.model("Document", documentSchema, "document");
