const mongoose = require("mongoose");
const { io } = require("../socket/io");
const database = require("../config/database");

const topicSchema = new mongoose.Schema({
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
        at: Date.now()

    },
    isDeleted: {
        type: Boolean,
        default: false
    }
}, {
    timestamps: true
});

const Topic = database.model("topic", topicSchema, "topic");

Topic.watch([], { fullDocument: "updateLookup" })
    .on("change", (change) => {
        switch (change.operationType) {
            case "insert":
            case "update":
            case "replace":
                io.emit("topic:update", change.fullDocument);
                break;

            case "delete":
                io.emit("topic:delete", change.documentKey._id);
                break;
        }
    });

module.exports = Topic;