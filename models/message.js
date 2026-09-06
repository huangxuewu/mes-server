const mongoose = require("mongoose");
const { io } = require("../socket/io");
const database = require("../config/database");
const { deliverMessageChange } = require('../socket/messageDelivery');

const attachmentSchema = new mongoose.Schema({
    type: { type: String, enum: ["Image", "Video", "Audio", "Document", "Other"], required: true },
    url: String,
    attachmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'MessageAttachment' },
    mime: String,
    size: { type: Number, required: true },
    filename: { type: String, required: true },
})

const messageSchema = new mongoose.Schema({
    clientRequestId: String,
    requestHash: String,
    revision: { type: Number, default: 0 },
    history: [{ content: mongoose.Schema.Types.Mixed, status: String, by: mongoose.Schema.Types.ObjectId, at: Date }],
    type: {
        type: String,
        enum: ["Text", "Todo", "Poll"],
        required: true,
        default: "Text"
    },
    from: { type: String, enum: ["User", "System", "AI"], required: true, default: "User" },
    topicId: { type: mongoose.Schema.Types.ObjectId, ref: "Topic", required: true },
    content: { type: mongoose.Schema.Types.Mixed, required: true },
    authorId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    status: { type: String, enum: ["Active", "Archived", "Deleted", "Retracted", "Modified"], default: "Active" },
    attachments: [attachmentSchema],
}, {
    timestamps: true
});

messageSchema.index({ authorId: 1, clientRequestId: 1 }, { unique: true, partialFilterExpression: { clientRequestId: { $type: 'string' } } });
messageSchema.index({ topicId: 1, createdAt: -1, _id: -1 });
const Message = database.model("Message", messageSchema, "message");

Message.watch([], { fullDocument: "updateLookup" })
    .on("change", (change) => {
        switch (change.operationType) {
            case "insert":
            case "update":
            case "replace":
                if (change.fullDocument) deliverMessageChange(io, change.fullDocument).catch(error => console.error('Message delivery failed:', error.message));
                break;

            case "delete":
                // Chat actions retain a retracted record and its audit history.
                break;
        }
    })

module.exports = Message;
