const mongoose = require("mongoose");
const database = require("../config/database");

const configSchema = new mongoose.Schema({
    name: { type: String, required: true },
    value: { type: String, required: true },
});

const machineParameterSchema = new mongoose.Schema({
    name: { type: String, required: true },
    description: { type: String },
    capacity: {
        output: { type: Number },
        unit: { type: String, enum: ['pcs/hr', 'pcs/min', 'pcs/sec'] },
    },
    config: [configSchema]
});

const lineSchema = new mongoose.Schema({
    name: { type: String, required: true },
    location: { type: String },
    description: { type: String },
    capacity: {
        output: { type: Number },
        unit: { type: String, enum: ['pcs/hr', 'pcs/min', 'pcs/sec'] },

    },
    status: { type: String, enum: ['Active', 'Inactive', 'In-Maintenance', 'Out-of-Service', 'Paused'], default: 'Active' },
    machineParameters: [machineParameterSchema]
});

module.exports = database.model("line", lineSchema, 'line');
