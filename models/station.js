const mongoose = require("mongoose");
require("../socket/io");
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
    screenshotsEnabled: { type: Boolean, default: true },
    screenshotGeneration: { type: Number, default: 0 },
    screenshotSupported: { type: Boolean, default: false },
    screenshotCleanup: { type: [String], default: [] },
    screenshot: {
        mime: { type: String, enum: ['image/jpeg', 'image/webp'] },
        stationId: String,
        revision: String,
        capturedAt: Date,
        width: Number,
        height: Number,
        size: Number,
    },
    lastSeenAt: {
        type: Date,
        default: null
    },
    computer: {
        hostname: String,
        platform: String,
        release: String,
        arch: String,
        cpu: String,
        cpuCount: Number,
        memoryBytes: Number,
        appVersion: String,
        ipAddresses: [String],
        remoteAddress: String,
        disks: { type: [{ _id: false, name: String, label: String, totalBytes: Number, availableBytes: Number }], default: null },
        devices: {
            cameras: { type: [String], default: null },
            speakers: { type: [String], default: null },
            microphones: { type: [String], default: null },
        },
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
            teamIds: {
                type: [mongoose.Schema.Types.ObjectId],
                default: [],
            },
        },
    },
}, {
    timestamps: true
});

const Station = database.model("station", stationSchema, "station");

module.exports = Station;
