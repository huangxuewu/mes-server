const dayjs = require("../utils/dayjs");
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
    },
    eventId: {
        type: String,
        default: null,
        index: true
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
        default: null
    },
    processedEventIds: {
        type: [String],
        default: []
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
        },
        honorShortMealBreak: { type: Boolean, default: false },
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

timecardSchema.index({ date: 1, employeeId: 1 });
timecardSchema.index({ employeeId: 1, date: 1 });
timecardSchema.index({ processedEventIds: 1 });

// Commands and employee locks live outside business documents; receipts survive date scope changes.
timecardSchema.statics.recordPunch = async function (type, payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload))
        throw Object.assign(new Error('Invalid punch command'), { code: 'INVALID_COMMAND', retryable: false });
    const { _id, image, station, location, method, ip, note } = payload;
    const eventId = payload.eventId || payload.idempotencyKey || crypto.randomUUID();
    const punchTime = payload.capturedAt == null ? new Date() : new Date(payload.capturedAt);
    if (!mongoose.isValidObjectId(_id) || typeof eventId !== 'string' || eventId.length > 200 || !Number.isFinite(punchTime.getTime()))
        throw Object.assign(new Error('Invalid punch command'), { code: 'INVALID_COMMAND', retryable: false });
    const targetId = new mongoose.Types.ObjectId(_id).toHexString();
    const date = dayjs(punchTime).tz(await dayjs.getFactoryTimeZone()).format('YYYY-MM-DD');
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify({
        type, target: targetId, capturedAt: payload.capturedAt == null ? null : punchTime.toISOString(),
        station: station ?? null, location: location ?? null, method: method ?? 'Station', note: note ?? '',
    })).digest('hex');
    const commands = this.db.collection('timecardCommand');
    const receiptId = `command:${eventId}`;
    const previousReceipt = await commands.findOne({ _id: receiptId }, { readConcern: { level: 'majority' } });
    if (previousReceipt && previousReceipt.fingerprint !== fingerprint)
        throw Object.assign(new Error('Punch command ID was reused with different data'), { code: 'CONFLICT', retryable: false });
    // A committed receipt remains valid even if the timecard was subsequently deleted.
    if (previousReceipt) return previousReceipt.receipt;
    const target = type === 'Clock In' ? null : await this.findById(_id).select('employeeId').lean();
    if (type !== 'Clock In' && !target)
        throw Object.assign(new Error('Timecard no longer exists'), { code: 'NOT_FOUND', retryable: false });
    const employeeId = type === 'Clock In' ? targetId : target.employeeId;
    const lockId = `employee:${employeeId}`;
    try {
        await commands.updateOne({ _id: lockId }, { $setOnInsert: { revision: 0 } }, { upsert: true, writeConcern: { w: 'majority' } });
    } catch (error) {
        if (error.code !== 11000) throw error;
    }
    const session = await this.db.startSession();
    let result;
    try {
        await session.withTransaction(async () => {
            await commands.updateOne({ _id: lockId }, { $inc: { revision: 1 } }, { session });
            const previous = await commands.findOne({ _id: receiptId }, { session });
            if (previous) {
                if (previous.fingerprint !== fingerprint)
                    throw Object.assign(new Error('Punch command ID was reused with different data'), { code: 'CONFLICT', retryable: false });
                result = previous.receipt;
                return;
            }
            // Recover receipts for commands accepted before the command journal was deployed.
            let timecard = await this.findOne({ processedEventIds: eventId }).session(session);
            if (timecard) {
                const punch = timecard.punches.find(item => item.eventId === eventId);
                if (String(timecard.employeeId) !== String(employeeId) || (type !== 'Clock In' && String(timecard._id) !== targetId)
                    || !punch || punch.type !== type || (payload.capturedAt != null && punch.time.getTime() !== punchTime.getTime()))
                    throw Object.assign(new Error('Punch command ID was reused with different data'), { code: 'CONFLICT', retryable: false });
            } else {
                timecard = type === 'Clock In'
                    ? await this.findOne({ employeeId, date, isDeleted: { $ne: true } }).session(session)
                    : await this.findOne({ _id, isDeleted: { $ne: true } }).session(session);
                if (!timecard && type !== 'Clock In')
                    throw Object.assign(new Error('Timecard no longer exists'), { code: 'NOT_FOUND', retryable: false });
                if (timecard && String(timecard.employeeId) !== String(employeeId))
                    throw Object.assign(new Error('Timecard employee changed; retry the command'), { code: 'UNAVAILABLE' });
                if (!timecard) timecard = new this({ date, employeeId });
                timecard.punches.push({ type, time: punchTime, image, station, location, method, ip, note, eventId });
                timecard.processedEventIds.push(eventId);
                await timecard.save({ session });
            }
            result = { _id: String(timecard._id), commandId: eventId, committed: true, date: timecard.date };
            await commands.insertOne({ _id: receiptId, fingerprint, receipt: result, committedAt: new Date() }, { session });
        }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
        return result;
    } catch (error) {
        if (error.name === 'ValidationError')
            throw Object.assign(error, { code: 'INVALID_COMMAND', retryable: false });
        if (error.code === 11000)
            throw Object.assign(new Error('Punch command ID was reused with different data'), { code: 'CONFLICT', retryable: false });
        throw error;
    } finally { await session.endSession(); }
};

for (const [action, type] of Object.entries({ clockIn: 'Clock In', clockOut: 'Clock Out', breakStart: 'Break Start', breakEnd: 'Break End' })) {
    timecardSchema.statics[action] = function (payload) { return this.recordPunch(type, payload); };
}

timecardSchema.statics.supplement = async function (payload) {
    const { date, employeeId, punches, station, location, method = 'Manual', ip, note } = payload;
    const sanitizedPunches = this.sanitizePunches(punches);

    const timecard = await this.create({
        date,
        employeeId,
        auditLog: [],
        punches: sanitizedPunches.map(punch => ({
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

timecardSchema.statics.sanitizePunches = function (punches, { preserveUndefined = false } = {}) {
    if (punches === undefined) return preserveUndefined ? undefined : [];
    if (!Array.isArray(punches)) throw new Error('Timecard punches must be an array');

    return punches.filter((punch) => punch && typeof punch === 'object' && !Array.isArray(punch));
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

const DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const DEFAULT_WORKING_DAYS = new Set(["monday", "tuesday", "wednesday", "thursday", "friday"]);
const FALLBACK_REGULAR_MINUTES = 480; // legacy flat 8h threshold, used only when no schedule resolves

function parseTimeToMinutes(time) {
    if (!time) return null;
    const [h, m] = String(time).split(":").map(Number);
    if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
    return h * 60 + m;
}

// Resolve the scheduled shift for an employee on a date, mirroring the client:
// team day override -> department default template -> global template -> attendance config
async function resolveScheduleBounds(employeeId, date) {
    try {
        if (!employeeId || !date) return null;

        const employee = await database.model("employee").findById(employeeId).select('team department').lean();
        if (!employee) return null;

        const dayName = DAY_NAMES[dayjs(date).day()];

        const Template = database.model("workScheduleTemplate");
        const select = 'isWorkingDay workStartTime workEndTime weekdayOverrides';
        const [override, departmentTemplate, configDoc] = await Promise.all([
            employee.team ? database.model('workSchedule').findOne({ teamId: employee.team, date }).select(select).lean() : null,
            employee.department ? Template.findOne({ isDefault: true, applyScope: 'department', departmentId: employee.department }).select(select).lean() : null,
            database.model('config').findOne({ key: 'attendance.workingHours', status: 'Active' }).select('value').lean(),
        ]);
        const template = departmentTemplate || await Template.findOne({ isDefault: true, applyScope: 'all' }).select(select).lean();

        const templateWeekday = template?.weekdayOverrides?.[dayName];
        const templateDay = template && templateWeekday && typeof templateWeekday === "object"
            ? { ...template, ...templateWeekday }
            : template;

        const global = configDoc?.value || {};
        const globalWeekday = global.weekdayOverrides?.[dayName] || null;
        const globalBase = { workStartTime: global.officialStartTime, workEndTime: global.officialEndTime };

        const sources = [override, templateDay, globalWeekday, globalBase];
        const pick = (field) => {
            for (const src of sources) if (src?.[field]) return src[field];
            return null;
        };

        const isWorkingDay = [override, templateDay, globalWeekday]
            .map(src => src?.isWorkingDay)
            .find(value => value != null) ?? DEFAULT_WORKING_DAYS.has(dayName);

        const startMinutes = parseTimeToMinutes(pick("workStartTime")) ?? parseTimeToMinutes("08:00");
        const endMinutes = parseTimeToMinutes(pick("workEndTime")) ?? parseTimeToMinutes("16:30");

        const timeZone = await dayjs.getFactoryTimeZone();
        const dayStart = dayjs.tz(date, timeZone).startOf("day");

        return {
            dayOff: !isWorkingDay,
            startMs: dayStart.add(startMinutes, "minute").valueOf(),
            endMs: dayStart.add(endMinutes, "minute").valueOf()
        };
    } catch (error) {
        console.error("Error resolving schedule bounds for timecard:", error);
        return null;
    }
}

// Function to calculate timecard totals based on punches.
// Overtime follows the work schedule: worked minutes before the scheduled start
// or after the scheduled end (all worked minutes on a scheduled day off).
function calculateTimecardTotals(punches, scheduleBounds = null, options = {}) {
    let workMinutes = 0;
    let breakMinutes = 0;
    let grossMinutes = 0;
    let overtimeMinutes = 0;

    const honorShortMeal = !!options.honorShortMeal;
    const mealMinutes = Number(options.mealMinutes) > 0 ? Number(options.mealMinutes) : 30;

    // Sort punches by time to ensure proper order
    const sortedPunches = punches.sort((a, b) => new Date(a.time) - new Date(b.time));

    let clockInTime = null;
    let breakStartTime = null;
    let totalWorkTime = 0;
    let totalBreakTime = 0;
    const workIntervals = [];

    for (const punch of sortedPunches) {
        switch (punch.type) {
            case "Clock In":
                clockInTime = new Date(punch.time);
                break;
            case "Clock Out":
                if (clockInTime) {
                    const punchTime = new Date(punch.time);
                    totalWorkTime += punchTime - clockInTime;
                    workIntervals.push({ start: clockInTime.getTime(), end: punchTime.getTime() });
                    clockInTime = null;
                }
                break;
            case "Break Start":
                if (clockInTime) {
                    const punchTime = new Date(punch.time);
                    totalWorkTime += punchTime - clockInTime;
                    workIntervals.push({ start: clockInTime.getTime(), end: punchTime.getTime() });
                    breakStartTime = punchTime;
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

    if (!honorShortMeal && mealMinutes > 0 && workIntervals.length >= 2) {
        const floorMs = mealMinutes * 60 * 1000;
        let best = -1;
        let bestGap = 0;
        for (let i = 0; i < workIntervals.length - 1; i++) {
            const gap = workIntervals[i + 1].start - workIntervals[i].end;
            if (gap > 0 && gap < floorMs && gap > bestGap) {
                bestGap = gap;
                best = i;
            }
        }
        if (best >= 0) {
            workIntervals[best + 1].start = workIntervals[best].end + floorMs;
            totalBreakTime += floorMs - bestGap;
        }
    }

    const flooredIntervals = workIntervals.filter(interval => interval.end > interval.start);
    totalWorkTime = flooredIntervals.reduce((sum, interval) => sum + (interval.end - interval.start), 0);

    // Convert milliseconds to minutes
    workMinutes = Math.round(totalWorkTime / (1000 * 60));
    breakMinutes = Math.round(totalBreakTime / (1000 * 60));

    // Gross minutes = work minutes + break minutes (if breaks are paid)
    grossMinutes = workMinutes + breakMinutes;

    if (scheduleBounds) {
        if (scheduleBounds.dayOff) {
            overtimeMinutes = workMinutes;
        } else {
            const outsideMs = flooredIntervals.reduce((total, interval) =>
                total
                + Math.max(0, Math.min(interval.end, scheduleBounds.startMs) - interval.start)
                + Math.max(0, interval.end - Math.max(interval.start, scheduleBounds.endMs)), 0);
            overtimeMinutes = Math.round(outsideMs / (1000 * 60));
        }
    } else if (workMinutes > FALLBACK_REGULAR_MINUTES) {
        overtimeMinutes = workMinutes - FALLBACK_REGULAR_MINUTES;
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
        if (!this.date) {
            this.date = await dayjs.businessDate();
        }

        if (this.punches && this.punches.length > 0) {
            // Sort punches by time to ensure they're always in chronological order
            this.punches.sort((a, b) => new Date(a.time) - new Date(b.time));
            const scheduleBounds = await resolveScheduleBounds(this.employeeId, this.date);
            this.totals = calculateTimecardTotals(this.punches, scheduleBounds, {
                honorShortMeal: this.overtime?.honorShortMealBreak,
            });
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
                .session(this.$session())
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
        // The save hook already recalculates totals, meal-break policy and the hash.
        if (doc) await doc.save();
    } catch (error) {
        console.error('Error in post-update hook for hash chain:', error);
    }
});

// Helper method to recalculate and update totals
timecardSchema.methods.recalculateTotals = async function () {
    if (this.punches && this.punches.length > 0) {
        const scheduleBounds = await resolveScheduleBounds(this.employeeId, this.date);
        this.totals = calculateTimecardTotals(this.punches, scheduleBounds);
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
                io.except('data-sync-v1').emit("timecard:update", change.fullDocument);
                break;
            case "delete":
                io.except('data-sync-v1').emit("timecard:delete", change.documentKey._id);
                break;
        }
    });

module.exports = Timecard;
