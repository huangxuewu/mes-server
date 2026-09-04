const mongoose = require("mongoose");
const database = require("../config/database");

const auditReferenceSchema = new mongoose.Schema({
    name: { type: String, required: true, trim: true },
    code: { type: String, required: true, trim: true, uppercase: true },
    description: { type: String, trim: true, default: "" },
    contentJson: {
        type: mongoose.Schema.Types.Mixed,
        default: () => ({ type: "doc", content: [{ type: "paragraph" }] }),
    },
    sourceLinks: [{
        label: { type: String, trim: true },
        url: { type: String, trim: true },
    }],
    status: { type: String, enum: ["Active", "Archived"], default: "Active" },
    systemManaged: { type: Boolean, default: false },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
}, { timestamps: true, collection: "auditReference" });

auditReferenceSchema.index({ code: 1 }, { unique: true });
auditReferenceSchema.index({ name: "text", description: "text" });

module.exports = database.model("AuditReference", auditReferenceSchema, "auditReference");
