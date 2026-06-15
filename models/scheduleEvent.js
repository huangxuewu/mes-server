const mongoose = require("mongoose");

const scheduleEventSchema = new mongoose.Schema({
    type: { type: String, enum: ["break", "meal"], default: "break" },
    startTime: { type: String, default: "" },
    endTime: { type: String, default: "" }
}, { _id: true });

module.exports = scheduleEventSchema;
