const db = require("../models");

const punchKey = (punch) => {
    if (punch?._id) return String(punch._id);
    return null;
};

const punchFingerprint = (punch) => JSON.stringify({
    type: punch?.type || "",
    time: punch?.time ? new Date(punch.time).toISOString() : "",
});

const punchesEqual = (a = [], b = []) => {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    return a.every((punch, i) => punchFingerprint(punch) === punchFingerprint(b[i]));
};

const markManualWhereChanged = (before = [], after = []) => {
    const beforeById = new Map(
        before.filter(p => punchKey(p)).map(p => [punchKey(p), p])
    );

    return after.map((punch, index) => {
        const id = punchKey(punch);
        const prev = id ? beforeById.get(id) : before[index];
        if (prev && punchFingerprint(prev) === punchFingerprint(punch))
            return punch;

        return { ...punch, method: punch.method === "Station" ? "Manual" : (punch.method || "Manual") };
    });
};

const buildAuditChanges = (before = [], after = []) => {
    const changes = [];
    const max = Math.max(before.length, after.length);
    for (let i = 0; i < max; i++) {
        const oldPunch = before[i];
        const newPunch = after[i];
        if (!oldPunch && newPunch) {
            changes.push({
                field: `punches[${i}]`,
                oldValue: "",
                newValue: `${newPunch.type} @ ${new Date(newPunch.time).toISOString()}`,
            });
            continue;
        }
        if (oldPunch && !newPunch) {
            changes.push({
                field: `punches[${i}]`,
                oldValue: `${oldPunch.type} @ ${new Date(oldPunch.time).toISOString()}`,
                newValue: "",
            });
            continue;
        }
        if (punchFingerprint(oldPunch) === punchFingerprint(newPunch)) continue;
        changes.push({
            field: `punches[${i}]`,
            oldValue: `${oldPunch.type} @ ${new Date(oldPunch.time).toISOString()}`,
            newValue: `${newPunch.type} @ ${new Date(newPunch.time).toISOString()}`,
        });
    }
    return changes;
};

const timecardPunchesHandler = {
    submitPermission: { action: "modify", resource: "timecard.record.modify" },
    approvePermission: { action: "approve", resource: "timecard.record.approve" },

    captureBefore: async (referenceId) => {
        const timecard = await db.timecard.findById(referenceId);
        if (!timecard) throw new Error("Timecard not found");
        return {
            beforeValue: timecard.punches?.map(p => (p.toObject ? p.toObject() : p)) || [],
            baseHash: timecard.currentHash || null,
            live: timecard,
        };
    },

    sanitizeAfter: (afterValue) => db.timecard.sanitizePunches(afterValue),

    hasMeaningfulDiff: (beforeValue, afterValue) => !punchesEqual(beforeValue, afterValue),

    checkConflict: async (referenceId, _baseHash, beforeValue) => {
        const timecard = await db.timecard.findById(referenceId);
        if (!timecard) throw new Error("Timecard not found");
        const liveValue = timecard.punches?.map(p => (p.toObject ? p.toObject() : p)) || [];
        // Compare punches to the snapshot at submit — matches "live punches changed" copy.
        // Full currentHash also includes totals/schedule and can false-positive.
        return {
            conflict: !punchesEqual(beforeValue || [], liveValue),
            liveHash: timecard.currentHash || null,
            liveValue,
            live: timecard,
        };
    },

    apply: async ({ referenceId, beforeValue, afterValue, reason, submittedBy }) => {
        const punches = markManualWhereChanged(beforeValue || [], afterValue || []);
        const changes = buildAuditChanges(beforeValue || [], punches);
        const timecard = await db.timecard.findByIdAndUpdate(
            referenceId,
            {
                $set: { punches },
                $push: {
                    auditLog: {
                        action: "update",
                        changes,
                        reason: reason || "",
                        createdAt: new Date(),
                        createdBy: submittedBy,
                    },
                },
            },
            { new: true, runValidators: true, context: "query" }
        );
        if (!timecard) throw new Error("Timecard not found");
        return timecard;
    },
};

const handlers = {
    "timecard.punches": timecardPunchesHandler,
};

const getHandler = (targetField) => {
    const handler = handlers[targetField];
    if (!handler) throw new Error(`Unknown targetField: ${targetField}`);
    return handler;
};

module.exports = { getHandler, punchesEqual };
