const mongoose = require("mongoose");
const { io } = require("../socket/io");
const database = require("../config/database");

const topicSchema = new mongoose.Schema({

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
        }
    });

module.exports = Topic;