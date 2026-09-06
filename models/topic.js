const mongoose = require("mongoose");
const { io } = require("../socket/io");
const database = require("../config/database");
const { deliverTopicChange } = require('../socket/messageDelivery');

const topicSchema = new mongoose.Schema({
    clientRequestId: String,
    requestHash: String,
    revision: { type: Number, default: 0 },
    title: {
        type: String,
        required: true
    },
    description: {
        type: String,
        required: true
    },
    creator: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        required: true
    },
    editors: {
        type: [mongoose.Schema.Types.ObjectId],
        ref: "User",
        required: true
    },
    participants: {
        type: [mongoose.Schema.Types.ObjectId],
        ref: "User",
        required: true
    },
    archived: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        required: true
    }],
    pinned: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        required: true
    }],
    lastMessage: {
        content: String,
        by: mongoose.Schema.Types.Mixed,
        at: Date
    },
    deadline: {
        type: String,
        description: "Deadline date YYYY-MM-DD for the topic primary task"
    },
    isDeleted: {
        type: Boolean,
        default: false
    }
}, {
    timestamps: true
});

topicSchema.index({ creator: 1, clientRequestId: 1 }, { unique: true, partialFilterExpression: { clientRequestId: { $type: 'string' } } });
topicSchema.index({ participants: 1, createdAt: -1, _id: -1 });
const Topic = database.model("topic", topicSchema, "topic");

Topic.watch([], { fullDocument: "updateLookup" })
    .on("change", (change) => {
        switch (change.operationType) {
            case "insert":
            case "update":
            case "replace":
                if (change.fullDocument) deliverTopicChange(io, change.fullDocument).catch(error => console.error('Topic delivery failed:', error.message));
                break;

            case "delete":
                // User-facing deletion is soft so recipient membership remains available.
                break;
        }
    });

module.exports = Topic;
