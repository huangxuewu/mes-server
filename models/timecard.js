const dayjs = require("dayjs");
const crypto = require("crypto");
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
    reason: { type: String, default: "" },
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
    overtime: {
        approvedMinutes: { type: Number, default: 0 },
        approvedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'user',
            default: null,
            set: function (v) {
                return v === "" ? null : v;
            }
        },
        approvedAt: { type: Date, default: null },
        reason: { type: String, default: "" },
        status: { type: String, enum: ["Pending", "Approved", "Rejected"], default: "Pending" },
        // selected range
        selectedEarlyRange: {
            start: { type: Date, default: null },
            end: { type: Date, default: null },
        },
        selectedLateRange: {
            start: { type: Date, default: null },
            end: { type: Date, default: null },
        }
    },
    status: { type: String, enum: ['Draft', 'Pending', 'Approved', 'Rejected'], default: 'Pending' },
    isDeleted: { type: Boolean, default: false },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'user' },
    previousHash: {
        type: String,
        default: null,
        description: "Hash of the previous timecard record in the chain"
    },
    currentHash: {
        type: String,
        default: null,
        description: "Hash of the current timecard record"
    }
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

timecardSchema.statics.supplement = async function (payload) {
    const { date, employeeId, punches, station, location, method = 'Manual', ip, note } = payload;

    const timecard = await this.create({
        date,
        employeeId,
        auditLog: [],
        punches: punches.map(punch => ({
            type: punch.type,
            time: new Date(punch.time),
            image: null,
            station: station,
            location: location,
            method: method,
            note: note,
            ip: ip,
        })),
    });

    return timecard;
}

// Function to calculate hash for timecard data integrity
function calculateTimecardHash(timecard) {
    // Create a string representation of all critical fields that shouldn't be modified
    const hashData = {
        employeeId: timecard.employeeId?.toString() || '',
        date: timecard.date || '',
        punches: (timecard.punches || []).map(punch => ({
            type: punch.type,
            time: punch.time?.toISOString() || '',
            image: punch.image || '',
            station: punch.station || '',
            location: punch.location || '',
            method: punch.method || '',
            ip: punch.ip || '',
            note: punch.note || '',
            status: punch.status || ''
        })),
        totals: {
            workMinutes: timecard.totals?.workMinutes || 0,
            breakMinutes: timecard.totals?.breakMinutes || 0,
            grossMinutes: timecard.totals?.grossMinutes || 0,
            overtimeMinutes: timecard.totals?.overtimeMinutes || 0
        },
        previousHash: timecard.previousHash || '',
        createdAt: timecard.createdAt?.toISOString() || '',
        policyVersion: timecard.policyVersion || '',
        rules: {
            paidBreak: timecard.rules?.paidBreak || false
        }
    };

    // Create a deterministic JSON string (sorted keys)
    const hashString = JSON.stringify(hashData, Object.keys(hashData).sort());

    // Generate SHA-256 hash
    return crypto.createHash('sha256').update(hashString).digest('hex');
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

// Pre-save hook to automatically calculate totals, sort punches, and maintain hash chain
timecardSchema.pre('save', async function (next) {
    try {
        if (this.punches && this.punches.length > 0) {
            // Sort punches by time to ensure they're always in chronological order
            this.punches.sort((a, b) => new Date(a.time) - new Date(b.time));
            const totals = calculateTimecardTotals(this.punches);
            this.totals = totals;
        }

        // Maintain hash chain
        // If this is a new document (not updating), get the previous timecard in the chain
        if (this.isNew || !this.currentHash) {
            // Find the most recent timecard for this employee, ordered by date then creation time
            const previousTimecard = await this.constructor
                .findOne({
                    employeeId: this.employeeId,
                    _id: { $ne: this._id }
                })
                .sort({ date: -1, createdAt: -1 })
                .exec();

            // Set previousHash from the most recent timecard's currentHash
            if (previousTimecard && previousTimecard.currentHash) {
                this.previousHash = previousTimecard.currentHash;
            } else {
                // This is the first timecard for this employee
                this.previousHash = null;
            }
        }
        // If updating an existing document, previousHash should remain unchanged
        // (it was set when the document was first created)

        // Calculate currentHash based on current data
        this.currentHash = calculateTimecardHash(this);

        next();
    } catch (error) {
        next(error);
    }
});

// Post-update hook to recalculate hash when timecard is updated via findByIdAndUpdate
// This ensures hash chain is maintained even when using direct MongoDB updates
timecardSchema.post(['findOneAndUpdate', 'findByIdAndUpdate'], async function (doc) {
    try {
        if (doc) {
            // Recalculate totals if punches exist
            if (doc.punches && doc.punches.length > 0) {
                doc.punches.sort((a, b) => new Date(a.time) - new Date(b.time));
                const totals = calculateTimecardTotals(doc.punches);
                doc.totals = totals;
            }

            // Recalculate hash (previousHash should remain unchanged on updates)
            doc.currentHash = calculateTimecardHash(doc);
            await doc.save();
        }
    } catch (error) {
        console.error('Error in post-update hook for hash chain:', error);
    }
});

// Helper method to recalculate and update totals
timecardSchema.methods.recalculateTotals = function () {
    if (this.punches && this.punches.length > 0) {
        this.totals = calculateTimecardTotals(this.punches);
    }
    return this;
};

// Method to verify the integrity of the current timecard
timecardSchema.methods.verifyIntegrity = function () {
    const calculatedHash = calculateTimecardHash(this);
    const isHashValid = calculatedHash === this.currentHash;

    return {
        isValid: isHashValid,
        calculatedHash: calculatedHash,
        storedHash: this.currentHash,
        message: isHashValid
            ? 'Timecard hash is valid'
            : 'Timecard hash mismatch - data may have been tampered with'
    };
};

// Static method to verify hash chain integrity for an employee
timecardSchema.statics.verifyChainIntegrity = async function (employeeId) {
    try {
        // Get all timecards for this employee, ordered chronologically
        const timecards = await this.find({ employeeId })
            .sort({ date: 1, createdAt: 1 })
            .exec();

        if (timecards.length === 0) {
            return {
                isValid: true,
                message: 'No timecards found for this employee',
                timecardsChecked: 0,
                violations: []
            };
        }

        const violations = [];
        let previousHash = null;

        for (let i = 0; i < timecards.length; i++) {
            const timecard = timecards[i];

            // Verify current hash
            const integrityCheck = timecard.verifyIntegrity();
            if (!integrityCheck.isValid) {
                violations.push({
                    timecardId: timecard._id,
                    date: timecard.date,
                    issue: 'Hash mismatch',
                    details: integrityCheck.message
                });
            }

            // Verify chain link
            if (previousHash !== null && timecard.previousHash !== previousHash) {
                violations.push({
                    timecardId: timecard._id,
                    date: timecard.date,
                    issue: 'Chain broken',
                    details: `Expected previousHash: ${previousHash}, Found: ${timecard.previousHash}`
                });
            }

            previousHash = timecard.currentHash;
        }

        return {
            isValid: violations.length === 0,
            message: violations.length === 0
                ? 'Hash chain integrity verified'
                : `Found ${violations.length} integrity violation(s)`,
            timecardsChecked: timecards.length,
            violations: violations
        };
    } catch (error) {
        return {
            isValid: false,
            message: `Error verifying chain integrity: ${error.message}`,
            timecardsChecked: 0,
            violations: [],
            error: error.message
        };
    }
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