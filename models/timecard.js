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
        default: "Station"
    },
    ip: {
        type: String,
        default: null
    },
    note: {
        type: String,
        default: "",
        description: "Office note for the timecard"
    },
    status: {
        type: String,
        enum: ["Pending", "Approved", "Rejected"],
        default: "Pending"
    }
});

const auditLogSchema = new mongoose.Schema({
    punchId: { type: mongoose.Schema.Types.ObjectId },
    action: { type: String, default: null, enum: ["create", "update", "delete", "approve", "reject"] },
    changes: [{
        field: { type: String, default: null },
        oldValue: { type: String, default: null },
        newValue: { type: String, default: null },
    }],
    createdAt: { type: Date, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'user', default: null },
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
    auditLog: [auditLogSchema],
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

timecardSchema.statics.clockIn = async function (payload) {
    const { _id, image, station, location, method, ip, note } = payload;
    const date = dayjs().format("YYYY-MM-DD");

    const existingTimecard = await this.findOne({ employeeId: _id, date: date });

    if (existingTimecard) {
        existingTimecard.punches.push({ type: "Clock In", time: new Date(), image, station, location, method, ip, note });
        const updatedTimecard = await existingTimecard.save();
        return updatedTimecard;
    }

    const timecard = await this.create({
        date: date,
        employeeId: _id,
        auditLog: [],
        punches: [{ type: "Clock In", time: new Date(), image, station, location, method, ip, note }],
    });

    return timecard;
}

timecardSchema.statics.breakStart = async function (payload) {
    const { _id, image, station, location, method, ip, note } = payload;
    const timecard = await this.findById(_id);
    if (timecard) {
        timecard.punches.push({ type: "Break Start", time: new Date(), image, station, location, method, ip, note });
        return await timecard.save();
    }
    return timecard;
}

timecardSchema.statics.breakEnd = async function (payload) {
    const { _id, image, station, location, method, ip, note } = payload;
    const timecard = await this.findById(_id);
    if (timecard) {
        timecard.punches.push({ type: "Break End", time: new Date(), image, station, location, method, ip, note });
        return await timecard.save();
    }
    return timecard;
}

timecardSchema.statics.clockOut = async function (payload) {
    const { _id, image, station, location, method, ip, note } = payload;
    const timecard = await this.findById(_id);
    if (timecard) {
        timecard.punches.push({ type: "Clock Out", time: new Date(), image, station, location, method, ip, note });
        return await timecard.save();
    }
    return timecard;
}

// Function to calculate timecard totals based on punches
function calculateTimecardTotals(punches) {
    let workMinutes = 0;
    let breakMinutes = 0;
    let grossMinutes = 0;
    let overtimeMinutes = 0;

    // Sort punches by time to ensure proper order
    const sortedPunches = punches.sort((a, b) => new Date(a.time) - new Date(b.time));

    let clockInTime = null;
    let breakStartTime = null;
    let totalWorkTime = 0;
    let totalBreakTime = 0;

    for (const punch of sortedPunches) {
        switch (punch.type) {
            case "Clock In":
                clockInTime = new Date(punch.time);
                break;
            case "Clock Out":
                if (clockInTime) {
                    const workSession = new Date(punch.time) - clockInTime;
                    totalWorkTime += workSession;
                    clockInTime = null;
                }
                break;
            case "Break Start":
                if (clockInTime) {
                    const workSession = new Date(punch.time) - clockInTime;
                    totalWorkTime += workSession;
                    breakStartTime = new Date(punch.time);
                    clockInTime = null;
                }
                break;
            case "Break End":
                if (breakStartTime) {
                    const breakSession = new Date(punch.time) - breakStartTime;
                    totalBreakTime += breakSession;
                    clockInTime = new Date(punch.time);
                    breakStartTime = null;
                }
                break;
        }
    }

    // Convert milliseconds to minutes
    workMinutes = Math.round(totalWorkTime / (1000 * 60));
    breakMinutes = Math.round(totalBreakTime / (1000 * 60));

    // Gross minutes = work minutes + break minutes (if breaks are paid)
    grossMinutes = workMinutes + breakMinutes;

    // Calculate overtime (assuming 8 hours = 480 minutes is regular time)
    const regularWorkMinutes = 480;
    if (workMinutes > regularWorkMinutes) {
        overtimeMinutes = workMinutes - regularWorkMinutes;
    }

    return {
        workMinutes,
        breakMinutes,
        grossMinutes,
        overtimeMinutes
    };
}

// Pre-save hook to automatically calculate totals
timecardSchema.pre('save', function (next) {
    if (this.punches && this.punches.length > 0) {
        const totals = calculateTimecardTotals(this.punches);
        this.totals = totals;
    }
    next();
});

// Helper method to recalculate and update totals
timecardSchema.methods.recalculateTotals = function () {
    if (this.punches && this.punches.length > 0) {
        this.totals = calculateTimecardTotals(this.punches);
    }
    return this;
};

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