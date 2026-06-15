const mongoose = require("mongoose");
const scheduleEventSchema = require("./scheduleEvent");

const workScheduleSchema = new mongoose.Schema({
    teamId: {
        type: mongoose.Schema.Types.ObjectId,
        required: true
    },
    departmentId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "department",
        required: true
    },
    date: {
        type: String,
        required: true
    },
    workStartTime: { type: String, default: "" },
    workEndTime: { type: String, default: "" },
    events: [scheduleEventSchema],
    isWorkingDay: { type: Boolean, default: null },
    note: { type: String, default: "" }
}, { timestamps: true });

workScheduleSchema.index({ teamId: 1, date: 1 }, { unique: true });
workScheduleSchema.index({ departmentId: 1, date: 1 });

module.exports = mongoose.model("workSchedule", workScheduleSchema);
