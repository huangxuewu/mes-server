const mongoose = require("mongoose");
const { io } = require("../socket/io");
const database = require("../config/database");

const rawDataSchema = new mongoose.Schema({
    name: String,
    type: {
        type: String,
        enum: ["text", "number", "date", "boolean", "image"],
        default: "text",
    },
    value: mongoose.Schema.Types.Mixed,
    options: mongoose.Schema.Types.Mixed,
    required: Boolean,
    tooltip: String,
    description: String,
    restrictions: {
        min: Number,
        max: Number,
        regex: String,
        required: Boolean,
        tooltip: String,
        description: String,
    },
});

const documentSchema = new mongoose.Schema({
    name: String,
    rawData: [rawDataSchema],
});

const Document = database.model("Document", documentSchema, "document");

module.exports = Document;