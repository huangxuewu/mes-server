const mongoose = require("mongoose");
const scheduleEventSchema = require("./scheduleEvent");

const workScheduleTemplateSchema = new mongoose.Schema({
    name: { type: String, default: "", required: true },
    isDefault: { type: Boolean, default: false },
    workStartTime: { type: String, default: "" },
    workEndTime: { type: String, default: "" },
    events: [scheduleEventSchema],
    weekdayOverrides: { type: mongoose.Schema.Types.Mixed, default: {} },
    note: { type: String, default: "" }
}, { timestamps: true });

workScheduleTemplateSchema.index({ name: 1 }, { unique: true });
workScheduleTemplateSchema.index({ isDefault: 1 });

module.exports = mongoose.model("workScheduleTemplate", workScheduleTemplateSchema);
