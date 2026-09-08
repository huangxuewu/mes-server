const productionTimes = (run, now) => {
    if (!run) return { elapsed: 0, running: 0, paused: 0 };
    const end = new Date(run.endedAt || now).getTime();
    const elapsed = Math.max(0, end - new Date(run.startedAt).getTime());
    let pauseStart = null;
    let paused = 0;
    for (const event of run.events || []) {
        if (event.action === 'pause') pauseStart = new Date(event.at).getTime();
        if (pauseStart !== null && ['resume', 'end'].includes(event.action)) {
            paused += Math.max(0, Math.min(end, new Date(event.at).getTime()) - pauseStart);
            pauseStart = null;
        }
    }
    if (pauseStart !== null) paused += Math.max(0, end - pauseStart);
    paused = Math.min(elapsed, paused);
    return { elapsed, paused, running: elapsed - paused };
};

const getProductionOutput = async (db, run, now) => {
    const end = Math.floor(now.getTime() / 600000) * 600000;
    const start = end - 23 * 600000;
    const buckets = Array.from({ length: 24 }, (_, index) => ({ bucketStart: new Date(start + index * 600000).toISOString(), pallets: 0, boxes: 0, pillows: 0 }));
    const totals = { pallets: 0, boxes: 0, pillows: 0, awaitingPutaway: 0, lastRegisteredAt: null };
    if (run) {
        const [result] = await db.pallet.aggregate([
            { $match: { productionRunId: run._id, status: { $ne: 'Voided' }, registeredAt: { $lte: now } } },
            { $facet: {
                summary: [{ $group: { _id: null, pallets: { $sum: 1 }, boxes: { $sum: '$boxesPerPallet' }, pillows: { $sum: '$quantity' },
                    awaitingPutaway: { $sum: { $cond: [{ $ne: ['$status', 'Putaway'] }, '$quantity', 0] } }, lastRegisteredAt: { $max: '$registeredAt' } } }],
                recent: [
                    { $match: { registeredAt: { $gte: new Date(start) } } },
                    { $group: { _id: { $floor: { $divide: [{ $subtract: ['$registeredAt', new Date(start)] }, 600000] } },
                        pallets: { $sum: 1 }, boxes: { $sum: '$boxesPerPallet' }, pillows: { $sum: '$quantity' } } },
                ],
            } },
        ]);
        if (result?.summary[0]) Object.assign(totals, result.summary[0]);
        delete totals._id;
        for (const bucket of result?.recent || []) {
            if (buckets[bucket._id]) Object.assign(buckets[bucket._id], { pallets: bucket.pallets, boxes: bucket.boxes, pillows: bucket.pillows });
        }
    }
    const times = productionTimes(run, now);
    return { totals, buckets, times, rates: {
        overall: times.elapsed > 0 ? totals.pillows * 3600000 / times.elapsed : null,
        running: times.running > 0 ? totals.pillows * 3600000 / times.running : null,
    } };
};

module.exports = { productionTimes, getProductionOutput };
