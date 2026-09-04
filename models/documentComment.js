const mongoose = require("mongoose");
const database = require("../config/database");

const replySchema = new mongoose.Schema({
    body: { type: String, required: true, trim: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    createdAt: { type: Date, default: Date.now },
}, { _id: true });

const documentCommentSchema = new mongoose.Schema({
    document: { type: mongoose.Schema.Types.ObjectId, ref: "Document", required: true },
    revision: Number,
    body: { type: String, required: true, trim: true },
    anchor: {
        relativeStart: String,
        relativeEnd: String,
        quote: String,
    },
    status: { type: String, enum: ["Open", "Resolved"], default: "Open" },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    resolvedAt: Date,
    replies: [replySchema],
}, { timestamps: true, collection: "documentComment" });

documentCommentSchema.index({ document: 1, status: 1, createdAt: -1 });

module.exports = database.model("DocumentComment", documentCommentSchema, "documentComment");
