const mongoose = require("mongoose");
const { io } = require("../socket/io");
const database = require("../config/database");

const stationSchema = new mongoose.Schema({
    stationId: {
        type: String,
        unique: true,
        sparse: true,
        lowercase: true,
        trim: true,
        match: /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    },
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
        default: null
    },
    application: {
        type: String,
        required: true,
        enum: ['SOFTWARE', 'SIGNAGE', 'TIMECARD', 'VISITOR', 'LOADBOARD', 'PORTAL']
    },
    status: {
        type: String,
        enum: ['Active', 'Inactive', 'Disabled'],
        default: 'Active'
    },
    allowedModules: [String],
    lastSeenAt: {
        type: Date,
        default: null
    },
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