const { randomUUID } = require('node:crypto');
const { classifyError, GmailDeferred } = require('./gmailQuota');

const DEFAULT_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const LEASE_MS = 45000;
const isRateLimitError = error => ['quota', 'dailyOrBandwidth'].includes(classifyError(error)?.reason)
    || /rate.?limit|quota/i.test(error?.message || '');

const publicStatus = state => ({
    syncStatus: state?.syncStatus || 'complete',
    lastSuccessfulSyncAt: state?.lastSuccessfulSyncAt || null,
    checkedAt: state?.lastSuccessfulSyncAt || null,
    nextRetryAt: state?.nextRetryAt && +state.nextRetryAt > 0 ? state.nextRetryAt : null,
    newMessages: state?.newMessages || 0,
    cached: state?.syncStatus !== 'complete',
    rateLimited: state?.syncStatus === 'waiting',
    revision: state?.revision || 0,
});

// One durable job for MES's configured mailbox. Quota is independently keyed by project/mailbox.
function createAppointmentRefreshCoordinator({ connection, executeStep, notify = () => {}, logger = console,
    intervalMs = DEFAULT_REFRESH_INTERVAL_MS, tickMs = 1000 }) {
    const states = () => connection.db.collection('gmailSync');
    const owner = randomUUID();
    const id = 'appointments';
    let timer;
    let running;
    let stopped = false;
    const initialize = async () => {
        await connection.asPromise();
        try {
            await states().updateOne({ _id: id }, { $setOnInsert: { revision: 0, syncStatus: 'complete',
                leaseUntil: new Date(0), nextRetryAt: new Date(0), lastSuccessfulSyncAt: null } }, { upsert: true });
        } catch (error) { if (error.code !== 11000) throw error; }
    };
    const status = async () => {
        await initialize();
        return publicStatus(await states().findOne({ _id: id }));
    };
    const request = async ({ force = false } = {}) => {
        await initialize();
        await states().updateOne({ _id: id, syncStatus: { $in: ['complete', 'failed'] },
            $expr: { $and: [{ $lte: ['$nextRetryAt', '$$NOW'] }, force ? true : {
                $lte: [{ $ifNull: ['$lastSuccessfulSyncAt', new Date(0)] }, { $subtract: ['$$NOW', intervalMs] }],
            }] } }, [{ $set: { syncStatus: 'queued', requestedAt: '$$NOW', newMessages: 0,
                revision: { $add: ['$revision', 1] } } }]);
        start();
        return status();
    };
    const leaseFilter = () => ({ _id: id, owner, $expr: { $gt: ['$leaseUntil', '$$NOW'] } });
    const tick = async () => {
        if (running || stopped || process.env.GMAIL_SYNC_PAUSED === 'true') return;
        running = (async () => {
            await initialize();
            const state = await states().findOneAndUpdate({ _id: id,
                syncStatus: { $in: ['queued', 'syncing', 'waiting'] },
                $expr: { $and: [{ $lte: ['$leaseUntil', '$$NOW'] }, { $lte: ['$nextRetryAt', '$$NOW'] }] } },
            [{ $set: { owner, leaseUntil: { $add: ['$$NOW', LEASE_MS] }, syncStatus: 'syncing' } }],
            { returnDocument: 'after', includeResultMetadata: false });
            if (!state) return;
            let leaseLost = false;
            const heartbeat = setInterval(() => {
                states().updateOne(leaseFilter(), [{ $set: { leaseUntil: { $add: ['$$NOW', LEASE_MS] } } }])
                    .then(result => { if (!result.matchedCount) leaseLost = true; })
                    .catch(() => { leaseLost = true; });
            }, LEASE_MS / 3);
            heartbeat.unref?.();
            try {
                const step = await executeStep(state);
                if (leaseLost) throw new Error('Gmail sync lease was lost');
                const session = await connection.startSession();
                try {
                    await session.withTransaction(async () => {
                        const locked = await states().updateOne(leaseFilter(), { $inc: { revision: 1 } }, { session });
                        if (!locked.matchedCount) throw new Error('Gmail sync lease was lost');
                        await step.apply?.(session);
                        await states().updateOne({ _id: id, owner }, [{ $set: {
                            ...Object.fromEntries(Object.entries(step.patch || {}).map(([key, value]) => [key, { $literal: value }])),
                            syncStatus: step.complete ? 'complete' : 'queued', attempts: 0,
                            nextRetryAt: new Date(0), leaseUntil: new Date(0),
                            ...(step.complete ? { lastSuccessfulSyncAt: '$$NOW' } : {}),
                        } }], { session });
                    }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
                } finally { await session.endSession(); }
            } catch (error) {
                const deferred = error instanceof GmailDeferred;
                const failure = error.gmailFailure || classifyError(error, Date.now(), state.attempts || 0);
                const attempts = deferred ? state.attempts || 0 : (state.attempts || 0) + 1;
                const retryable = deferred || Boolean(failure);
                const nextRetryAt = error.nextRetryAt || failure?.nextRetryAt || new Date(Date.now() + intervalMs);
                if (retryable && attempts > 5) nextRetryAt.setTime(Math.max(+nextRetryAt,
                    Date.now() + Math.min(60 * 60 * 1000, intervalMs * 2 ** Math.min(4, Math.floor((attempts - 1) / 6)))));
                await states().updateOne(leaseFilter(), { $set: { attempts, nextRetryAt,
                    syncStatus: retryable ? 'waiting' : 'failed', leaseUntil: new Date(0) }, $inc: { revision: 1 } });
                if (!deferred) logger.warn?.(retryable ? 'gmail.sync.deferred' : 'gmail.sync.failed', {
                    reason: failure?.reason || (error.code === 11000 ? 'duplicateKey' : 'operationFailed'),
                    code: error.code || error.name, attempts,
                    ...(error.code === 11000 ? {
                        collection: error.message?.match(/collection:\s+(\S+)/)?.[1],
                        index: error.message?.match(/index:\s+(\S+)\s+dup key/)?.[1],
                        keyFields: Object.keys(error.keyPattern || {}),
                    } : {}),
                });
            } finally {
                clearInterval(heartbeat);
                notify(await status());
            }
        })().catch(error => logger.error?.('gmail.sync.unavailable', { code: error.code || 'UNAVAILABLE' }))
            .finally(() => { running = null; });
        await running;
    };
    const start = () => {
        if (timer) return;
        stopped = false;
        timer = setInterval(tick, tickMs);
        timer.unref?.();
        void tick();
    };
    const stop = async () => { stopped = true; clearInterval(timer); timer = null; await running; };
    return { request, status, start, stop, tick };
}

module.exports = { DEFAULT_REFRESH_INTERVAL_MS, isRateLimitError, publicStatus, createAppointmentRefreshCoordinator };
