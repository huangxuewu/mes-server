const mongoose = require("mongoose");
const database = require("../config/database");
const { io } = require("../socket/io");

const repeatRuleSchema = new mongoose.Schema({
    frequency: {
        type: String,
        enum: ["daily", "weekly", "biweekly", "monthly"],
        default: "weekly",
    },
    days: { type: [Number], default: [] },
    startTime: { type: String, default: "09:00" },
    endTime: { type: String, default: "10:00" },
    until: { type: String, default: "" },
}, { _id: false });

const calendarEventSchema = new mongoose.Schema({
    title: { type: String, required: true },
    start: { type: Date, required: true },
    end: { type: Date, required: true },
    visibility: {
        type: String,
        enum: ["public", "private"],
        default: "private",
    },
    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    participantIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
    contactParticipantIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "contact" }],
    optOutIds: {
        type: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
        default: [],
    },
    repeat: { type: Boolean, default: false },
    repeatRule: repeatRuleSchema,
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
}, { timestamps: true });

const CalendarEvent = database.model("calendarEvent", calendarEventSchema, "calendarEvent");

CalendarEvent.watch([], { fullDocument: "updateLookup" })
    .on("change", (change) => {
        switch (change.operationType) {
            case "insert":
            case "update":
            case "replace":
                io.emit("calendarEvent:update", change.fullDocument);
                break;
            case "delete":
                io.emit("calendarEvent:delete", change.documentKey._id);
                break;
        }
    });

module.exports = CalendarEvent;
