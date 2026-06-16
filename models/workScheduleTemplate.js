const mongoose = require("mongoose");
const scheduleEventSchema = require("./scheduleEvent");

const workScheduleTemplateSchema = new mongoose.Schema({
    teamId: {
        type: mongoose.Schema.Types.ObjectId,
        required: true
    },
    departmentId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "department",
        required: true
    },
    name: { type: String, default: "", required: true },
    isDefault: { type: Boolean, default: false },
    workStartTime: { type: String, default: "" },
    workEndTime: { type: String, default: "" },
    events: [scheduleEventSchema],
    weekdayOverrides: { type: mongoose.Schema.Types.Mixed, default: {} },
    note: { type: String, default: "" }
}, { timestamps: true });

workScheduleTemplateSchema.index({ teamId: 1, name: 1 }, { unique: true });
workScheduleTemplateSchema.index({ departmentId: 1 });
workScheduleTemplateSchema.index({ teamId: 1, isDefault: 1 });

module.exports = mongoose.model("workScheduleTemplate", workScheduleTemplateSchema);
