const db = require('../../models');
const { getActiveSessionUser, hasPermission } = require('../session');
const { getProductionOutput } = require('../../utils/productionMetrics');

module.exports = socket => {
    socket.on('productionHealth:get', async (_payload, callback) => {
        try {
            const user = await getActiveSessionUser(socket);
            if (!hasPermission(user, 'view', 'production.run') && !hasPermission(user, 'update', 'production.run'))
                return callback({ status: 'error', message: 'productionRun.errors.permission' });
            const [lines, latestRuns] = await Promise.all([
                db.line.find({}, { name: 1, location: 1, status: 1 }).sort({ name: 1 }).lean(),
                db.productionRun.aggregate([
                    { $sort: { lineId: 1, startedAt: -1, _id: -1 } },
                    { $group: { _id: '$lineId', run: { $first: '$$ROOT' } } },
                ]),
            ]);
            const now = new Date();
            const runsByLine = new Map(latestRuns.map(item => [String(item._id), item.run]));
            const items = await Promise.all(lines.map(async line => {
                const run = runsByLine.get(String(line._id)) || null;
                const output = await getProductionOutput(db, run, now);
                const pause = run?.status === 'Paused' ? [...run.events].reverse().find(event => event.action === 'pause') : null;
                return { line, run, ...output, pauseReason: pause?.reason || '' };
            }));
            callback({ status: 'success', payload: { items, serverTime: now } });
        } catch (error) { callback({ status: 'error', message: error.message }); }
    });
};
