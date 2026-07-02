const mongoose = require("mongoose");
const database = require("../config/database");
const { io } = require("../socket/io");

const calendarTaskSchema = new mongoose.Schema({
    text: { type: String, required: true },
    dueDate: { type: String, default: null },
    taskMode: {
        type: String,
        enum: ["self", "collaborate"],
        default: "self",
    },
    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    participantIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
    optOutIds: {
        type: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
        default: [],
    },
    completions: { type: mongoose.Schema.Types.Mixed, default: {} },
    completed: { type: Boolean, default: false },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
}, { timestamps: true });

const CalendarTask = database.model("calendarTask", calendarTaskSchema, "calendarTask");

CalendarTask.watch([], { fullDocument: "updateLookup" })
    .on("change", (change) => {
        switch (change.operationType) {
            case "insert":
            case "update":
            case "replace":
                io.emit("calendarTask:update", change.fullDocument);
                break;
            case "delete":
                io.emit("calendarTask:delete", change.documentKey._id);
                break;
        }
    });

module.exports = CalendarTask;
