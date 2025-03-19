const mongoose = require("mongoose");
const database = require("../config/database");

const staffSchema = new mongoose.Schema({
    index: Number,
    position: String,
    // number of staffs required for this position
    // if manning is 0, it means the position is not required
    // if manning is 4 but only 2 staffs coming today, means only has 50% of the output capacity
    manning: Number,
    isSupportRole: Boolean,
    description: String,
    skills: []
})

// config for production line
const lineSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true
    },
    description: {
        type: String,
        required: true
    },
    picture: String,
    location: String,
    capacity: {
        output: Number, // output capacity per hour
        unit: {
            type: String,
            enum: ["kg", "g", "pcs"]
        },
        efficiencyRate: Number // efficiency rate of the line , default is 85%
    },
    staffs: [staffSchema],
    products: [],             // products that can be produced on this line
    procedures: [],           // procedures that can be performed on this line
    maintenanceSchedule: [],  // maintenance schedule for this line
    status: {
        type: String,
        enum: ["Active", "Inactive", "Maintenance"],
        default: "Active"
    },
})

module.exports = database.model("line", lineSchema, 'line');
