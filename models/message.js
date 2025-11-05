const mongoose = require("mongoose");
const { io } = require("../socket/io");
const database = require("../config/database");

const attachmentSchema = new mongoose.Schema({
    type: { type: String, enum: ["image", "video", "audio", "document", "other"], required: true },
    url: { type: String, required: true },
    filename: { type: String, required: true },
    size: { type: Number, required: true }
})

const messageSchema = new mongoose.Schema({
    from: { type: String, enum: ["User", "System", "AI"], required: true },
    topicId: { type: mongoose.Schema.Types.ObjectId, ref: "Topic", required: true },
    content: { type: mongoose.Schema.Types.Mixed, required: true },
    authorId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    status: { type: String, enum: ["Active", "Archived", "Deleted", "Retracted", "Modified"], default: "Active" },
    attachments: [attachmentSchema],
}, {
    timestamps: true
});

const Message = database.model("Message", messageSchema, "message");

Message.watch([], { fullDocument: "updateLookup" })
    .on("change", (change) => {
        switch (change.operationType) {
            case "insert":
            case "update":
            case "replace":
                io.emit("message:update", change.fullDocument);
                break;

            case "delete":
                io.emit("message:delete", change.documentKey._id);
                break;
        }
    })

module.exports = Message;