const mongoose = require("mongoose");
const { io } = require("../socket/io");
const database = require("../config/database");

const stationSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true
    },
    description: {
        type: String
    },
    location: {
        type: String,
        required: true
    },
    macAddress: {
        type: String,
        required: true
    },
    application:{
        type: String,
        required: true
    },
    status: {
        type: String,
        enum: ['Active', 'Inactive', 'Disabled'],
        default: 'Active'
    },
    allowModules: [String]
}, {
    timestamps: true
});

const Station = database.model("station", stationSchema, "station");

module.exports = Station;