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
    application: {
        type: String,
        required: true
    },
    status: {
        type: String,
        enum: ['Active', 'Inactive', 'Disabled'],
        default: 'Active'
    },
    allowedModules: [String],
    config: {
        boardType: {
            type: String,
            enum: ['loadboard', 'bulletin'],
        },
        departmentId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'department',
            default: null,
        },
        bulletin: {
            pages: {
                type: [String],
                default: ['schedule', 'performance'],
            },
            rotateSeconds: {
                type: Number,
                default: 20,
            },
        },
    },
}, {
    timestamps: true
});

const Station = database.model("station", stationSchema, "station");

module.exports = Station;