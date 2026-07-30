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

const punchRowKey = row =>
    `${row?.beforeIndex ?? "x"}:${row?.afterIndex ?? "x"}`;

const buildPunchRows = (before = [], after = []) => {
    const usedAfter = new Set();
    const rows = [];

    before.forEach((punch, beforeIndex) => {
        let match = null;
        let afterIndex = -1;
        if (punch._id) {
            afterIndex = after.findIndex(p => String(p._id) === String(punch._id));
            if (afterIndex >= 0) match = after[afterIndex];
        }

        if (!match && after[beforeIndex] && !usedAfter.has(beforeIndex) && !after[beforeIndex]._id) {
            afterIndex = beforeIndex;
            match = after[afterIndex];
        }

        if (afterIndex >= 0) usedAfter.add(afterIndex);
        if (!match) {
            rows.push({ status: "removed", beforeIndex, afterIndex: null });
            return;
        }

        rows.push({
            status: punchFingerprint(punch) === punchFingerprint(match) ? "same" : "changed",
            beforeIndex,
            afterIndex,
        });
    });

    after.forEach((punch, afterIndex) => {
        if (usedAfter.has(afterIndex)) return;
        if (punch._id && before.some(p => String(p._id) === String(punch._id))) return;
        rows.push({ status: "added", beforeIndex: null, afterIndex });
    });

    return rows;
};

const reviewAfter = (before = [], after = [], rejectedChanges = []) => {
    const changedRows = buildPunchRows(before, after).filter(row => row.status !== "same");
    const available = new Map(changedRows.map(row => [punchRowKey(row), row]));
    const rejected = [...new Map(
        (Array.isArray(rejectedChanges) ? rejectedChanges : [])
            .map(change => available.get(punchRowKey(change)))
            .filter(Boolean)
            .map(row => [punchRowKey(row), row])
    ).values()];
    const reviewed = [...after];

    rejected
        .filter(row => row.status === "changed")
        .forEach(row => reviewed[row.afterIndex] = before[row.beforeIndex]);

    rejected
        .filter(row => row.status === "added")
        .sort((a, b) => b.afterIndex - a.afterIndex)
        .forEach(row => reviewed.splice(row.afterIndex, 1));

    rejected
        .filter(row => row.status === "removed")
        .sort((a, b) => a.beforeIndex - b.beforeIndex)
        .forEach(row => reviewed.splice(Math.min(row.beforeIndex, reviewed.length), 0, before[row.beforeIndex]));

    return {
        afterValue: reviewed,
        rejectedChanges: rejected.map(({ beforeIndex, afterIndex }) => ({ beforeIndex, afterIndex })),
    };
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

    reviewAfter,

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
