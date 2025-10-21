const dayjs = require("dayjs");
const mongoose = require("mongoose");
const { io } = require("../socket/io");
const database = require("../config/database");

const punchSchema = new mongoose.Schema({
    type: {
        type: String,
        enum: ["Clock In", "Clock Out", "Break Start", "Break End"],
        required: true
    },
    time: {
        type: Date,
        required: true
    },
    image: {
        type: String,
        default: null
    },
    station: {
        type: String,
        default: null
    },
    location: {
        type: String,
        default: null
    },
    method: {
        type: String,
        enum: ["Manual", "Automatic", "Station"],
        default: "Manual"
    },
    ip: {
        type: String,
        default: null
    },
    note: {
        type: String,
        default: ""
    }
});

const timecardSchema = new mongoose.Schema({
    employeeId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "employee",
        required: true
    },
    date: {
        type: String,
        default: () => dayjs().format("YYYY-MM-DD")
    },
    punches: [punchSchema],
    totals: {
        workMinutes: {
            type: Number,
            default: 0
        },
        breakMinutes: {
            type: Number,
            default: 0
        },
        grossMinutes: {
            type: Number,
            default: 0
        },
        overtimeMinutes: {
            type: Number,
            default: 0
        }
    },
    policyVersion: {
        type: String,
    },
    rules: {
        paidBreak: {
            type: Boolean,
            default: false
        },

    },
    status: { type: String, enum: ['Draft', 'Pending', 'Approved', 'Rejected'], default: 'Pending' },
    isDeleted: { type: Boolean, default: false },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'user' }
}, {
    timestamps: true
});

timecardSchema.methods.clockIn = async function ({ image, station, location, method, ip, note }) {
    const timecard = await this.model("timecard").findByIdAndUpdate(this._id, {
        $push: {
            punches: { type: "Clock In", time: new Date(), image, station, location, method, ip, note }
        }
    }, { new: true });
    return timecard;
}



const Timecard = database.model("timecard", timecardSchema, 'timecard');

Timecard.watch([], { fullDocument: "updateLookup" })
    .on("change", (change) => {
        switch (change.operationType) {
            case "insert":
            case "update":
            case "replace":
                io.emit("timecard:update", change.fullDocument);
                break;
            case "delete":
                io.emit("timecard:delete", change.documentKey._id);
                break;
        }
    });

module.exports = Timecard;