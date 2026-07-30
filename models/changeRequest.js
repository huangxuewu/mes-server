const mongoose = require("mongoose");
const database = require("../config/database");
const { io } = require("../socket/io");

const changeRequestSchema = new mongoose.Schema({
    referenceId: {
        type: mongoose.Schema.Types.ObjectId,
        required: true,
        index: true,
    },
    targetField: {
        type: String,
        required: true,
        trim: true,
    },
    beforeValue: { type: mongoose.Schema.Types.Mixed, default: null },
    afterValue: { type: mongoose.Schema.Types.Mixed, default: null },
    rejectedChanges: { type: mongoose.Schema.Types.Mixed, default: () => [] },
    reason: { type: String, required: true, trim: true },
    status: {
        type: String,
        enum: ["Pending", "Approved", "Rejected", "Cancelled"],
        default: "Pending",
        index: true,
    },
    submittedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        required: true,
    },
    submittedAt: { type: Date, default: Date.now },
    verdictBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        default: null,
    },
    verdictAt: { type: Date, default: null },
    verdictNote: { type: String, default: "", trim: true },
    baseHash: { type: String, default: null },
}, { timestamps: true });

changeRequestSchema.index(
    { referenceId: 1, targetField: 1 },
    { unique: true, partialFilterExpression: { status: "Pending" } }
);
changeRequestSchema.index({ status: 1, targetField: 1, submittedAt: -1 });

const ChangeRequest = database.model("changeRequest", changeRequestSchema, "changeRequest");

ChangeRequest.watch([], { fullDocument: "updateLookup" })
    .on("change", (change) => {
        switch (change.operationType) {
            case "insert":
            case "update":
            case "replace":
                io.emit("changeRequest:update", change.fullDocument);
                break;
            case "delete":
                io.emit("changeRequest:delete", change.documentKey._id);
                break;
        }
    });

module.exports = ChangeRequest;
