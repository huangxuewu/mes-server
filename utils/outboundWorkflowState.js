const eligibleShipments = rows => rows.filter(row => !['Completed', 'Cancelled'].includes(row.status));
const sameTime = (a, b) => new Date(a || 0).getTime() === new Date(b || 0).getTime();
const getMilestones = rows => {
    const active = eligibleShipments(rows);
    const labeled = active.length > 0 && active.every(row => row.checklist?.labeled?.status === true);
    const inspected = labeled && active.every(row => row.checklist?.inspected?.status === true);
    const releaseId = active[0]?.inspectionRelease?.id;
    const released = inspected && !!releaseId && active.every(row => row.inspectionRelease?.id === releaseId
        && row.inspectionRelease.loadNumber === row.loadNumber
        && sameTime(row.inspectionRelease.inspectedAt, row.checklist.inspected.timestamp)
        && sameTime(row.inspectionRelease.labeledAt, row.checklist.labeled.timestamp));
    return { labeled, inspected, released, releaseId: released ? releaseId : null };
};
const notificationMilestones = rows => {
    const { labeled, released } = getMilestones(rows);
    return { labeled, inspected: released };
};

const validateDesktopChecklist = (previous, next, rows) => {
    for (const entry of Object.values(next.checklist || {}))
        if (entry?.status !== undefined && typeof entry.status !== 'boolean') throw new Error('signaturePad.invalidMessage');
    if (!previous?.checklist?.inspected?.status && next.checklist?.inspected?.status === true)
        throw new Error('signaturePad.inspectionPadOnly');
    if (previous?.checklist?.inspected?.status && next.checklist?.inspected?.status !== true) {
        if (['Completed', 'Cancelled'].includes(previous.status)) throw new Error('signaturePad.workflowClosed');
        if (previous.checklist?.loaded?.status) throw new Error('signaturePad.undoLoadedFirst');
    }
    if (!previous?.checklist?.loaded?.status && next.checklist?.loaded?.status === true
        && (!getMilestones(rows).released || !getMilestones([{ ...next, status: previous?.status }]).released))
        throw new Error('signaturePad.inspectionRequired');
};

const createOutboundWorkflowState = models => {
    const readLoad = async (loadNumber, session) => {
        let query = models.outbound.find({ 'loads.loadNumber': loadNumber }, { loads: 1 });
        if (session) query = query.session(session);
        return (await query.lean()).flatMap(record => record.loads.filter(row => row.loadNumber === loadNumber));
    };
    // This document serializes mobile and desktop changes to the same load. It is not an inspection seal.
    const run = async (numbers, work) => {
        const loadNumbers = [...new Set(numbers.filter(Boolean))].sort();
        const session = await models.outbound.startSession();
        try {
            let result;
            for (let attempt = 0; ; attempt++) {
                try {
                    await session.withTransaction(async () => {
                        const states = new Map();
                        for (const number of loadNumbers) {
                            const baseline = notificationMilestones(await readLoad(number, session));
                            const state = await models.outboundWorkflowState.findOneAndUpdate({ _id: number },
                                { $inc: { revision: 1 }, $setOnInsert: baseline },
                                { session, upsert: true, new: true, setDefaultsOnInsert: false });
                            states.set(number, state);
                        }
                        result = await work(session);
                        for (const number of loadNumbers) {
                            const previous = states.get(number);
                            const rows = await readLoad(number, session);
                            const next = notificationMilestones(rows);
                            if (!getMilestones(rows).released && rows.some(row => row.inspectionRelease?.id))
                                await models.outbound.updateMany({ 'loads.loadNumber': number }, { $unset: { 'loads.$[load].inspectionRelease': '' } },
                                    { session, arrayFilters: [{ 'load.loadNumber': number }] });
                            const patch = { ...next };
                            for (const stage of ['labeled', 'inspected']) {
                                if (!next[stage] || previous[stage]) continue;
                                const counter = await models.counter.findByIdAndUpdate('signature-pad-notifications', { $inc: { sequence: 1 } },
                                    { session, new: true, upsert: true, setDefaultsOnInsert: false });
                                const createdAt = new Date();
                                await models.signaturePadNotification.create([{ _id: counter.sequence, loadNumber: number, stage,
                                    createdAt, expiresAt: new Date(createdAt.getTime() + 86400000) }], { session });
                                patch[stage + 'Event'] = counter.sequence;
                            }
                            await models.outboundWorkflowState.updateOne({ _id: number }, { $set: patch }, { session });
                        }
                    });
                    return result;
                } catch (error) {
                    // Concurrent first use can race the unique load/counter inserts.
                    if (error.code !== 11000 || attempt >= 2) throw error;
                }
            }
        } finally { await session.endSession(); }
    };

    const notifications = async after => {
        if (!Number.isSafeInteger(after) || after < 0) throw new Error('signaturePad.invalidMessage');
        const events = await models.signaturePadNotification.find({ _id: { $gt: after }, expiresAt: { $gt: new Date() } }).sort({ _id: 1 }).limit(100).lean();
        const visible = [];
        for (const event of events) {
            const state = await models.outboundWorkflowState.findById(event.loadNumber).lean();
            if (state?.[event.stage + 'Event'] !== event._id || !notificationMilestones(await readLoad(event.loadNumber))[event.stage]) continue;
            visible.push({ id: event._id, loadNumber: event.loadNumber, stage: event.stage, createdAt: event.createdAt });
        }
        return { events: visible, cursor: events.at(-1)?._id ?? after };
    };

    // Reconcile metadata/import changes and recover milestone state after a server restart.
    // Unknown loads are initialized at their current state, without historical alerts.
    const reconcile = async () => {
        const records = await models.outbound.find({ loads: { $elemMatch: { status: { $nin: ['Completed', 'Cancelled'] } } } }, { loads: 1 }).lean();
        const states = await models.outboundWorkflowState.find().lean();
        const groups = new Map(states.map(row => [row._id, []]));
        for (const record of records) for (const row of record.loads || []) {
            if (!row.loadNumber) continue;
            if (!groups.has(row.loadNumber)) groups.set(row.loadNumber, []);
            groups.get(row.loadNumber).push(row);
        }
        const saved = new Map(states.map(row => [row._id, row]));
        for (const [number, rows] of groups) {
            const next = notificationMilestones(rows), previous = saved.get(number);
            if (!previous || next.labeled !== previous.labeled || next.inspected !== previous.inspected)
                await run([number], async () => {});
        }
    };
    const start = () => {
        let stopped = false, timer;
        const tick = async () => {
            try { await reconcile(); }
            catch (error) { console.error('Outbound milestone refresh failed', error.message); }
            if (!stopped) { timer = setTimeout(tick, 30000); timer.unref(); }
        };
        void tick();
        return () => { stopped = true; clearTimeout(timer); };
    };
    return { run, readLoad, notifications, reconcile, start };
};

module.exports = { eligibleShipments, getMilestones, validateDesktopChecklist, createOutboundWorkflowState };
