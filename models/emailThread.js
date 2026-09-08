const mongoose = require("mongoose");
const { io } = require("../socket/io");
const database = require("../config/database");

const richSchema = new mongoose.Schema({
    scac: { type: String, default: null },
    sender: { type: String, default: null },
    action: { type: String, default: null },
    loadNumber: { type: String, default: null, description: "Canonical load number, resolved even when the email only mentioned the PRO number" },
    date: { type: String, default: null, description: "YYYY-MM-DD" },
    time: { type: String, default: null, description: "Military trucking time, e.g. 1400" },
    intent: { type: String, default: "other", enum: ["request", "confirm", "change", "eta", "other"] },
}, {
    _id: false
});

const messageSchema = new mongoose.Schema({
    messageId: { type: String, default: "", description: "Gmail message id (dedupe key)" },
    rfcMessageId: { type: String, default: "", description: "RFC 2822 Message-ID header, used for In-Reply-To when replying" },
    from: { type: String, default: "" },
    to: { type: String, default: "" },
    date: { type: Date, default: null },
    body: { type: String, default: "", description: "Plain-text body (trimmed)" },
    summary: { type: String, default: "", description: "Plain-text AI one-liner" },
    rich: { type: richSchema, default: null, description: "Structured version of the summary for styled rendering" },
    isOutgoing: { type: Boolean, default: false },
    loadNumbers: [{ type: String }],
}, {
    _id: false
});

const loadAssociationSchema = new mongoose.Schema({
    loadNumber: { type: String, required: true },
    proNumber: { type: String, default: "" },
    scac: { type: String, default: "" },
    status: { type: String, default: "New", enum: ["New", "Time Proposed", "Confirmed", "Scheduled", "Closed"] },
    proposedTime: { type: Date, default: null },
}, {
    _id: false
});

const emailThreadSchema = new mongoose.Schema({
    threadId: { type: String, required: true, description: "Gmail thread id" },
    mailbox: { type: String, index: true, description: "Hashed Gmail mailbox identity" },
    loadNumber: { type: String, default: "", description: "Canonical id — resolved from either load number OR pro number in the email" },
    proNumber: { type: String, default: "", description: "Kept for matching/search; never the display value" },
    scac: { type: String, default: "" },
    subject: { type: String, default: "" },
    status: { type: String, default: "New", enum: ["New", "Time Proposed", "Confirmed", "Scheduled", "Closed"] },
    proposedTime: { type: Date, default: null, description: "Time the manager proposed in a reply" },
    loadAssociations: [loadAssociationSchema],
    messages: [messageSchema],
}, {
    timestamps: true
});

emailThreadSchema.index({ mailbox: 1, threadId: 1 }, { unique: true, name: 'mailbox_thread_unique' });
const EmailThread = database.model("emailThread", emailThreadSchema, "emailThread");

EmailThread.createIndexes({
    "threadId": 1,
    "loadNumber": 1,
});

EmailThread
    .watch([], { fullDocument: "updateLookup" })
    .on("change", (change) => {
        switch (change.operationType) {
            case "insert":
            case "update":
            case "replace":
                io.emit("emailThread:update", change.fullDocument);
                break;
            case "delete":
                io.emit("emailThread:delete", change.documentKey._id);
                break;
        }
    });

module.exports = EmailThread;
