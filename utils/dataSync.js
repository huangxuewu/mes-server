const { randomUUID, createHash } = require('node:crypto');
const dayjs = require('dayjs');
dayjs.extend(require('dayjs/plugin/utc'));
dayjs.extend(require('dayjs/plugin/timezone'));

const COLLECTIONS = {
    employees: 'employee', departments: 'department', positions: 'position', timecards: 'timecard',
    orders: 'order', inbound: 'inbound', outbound: 'outbound', products: 'product',
    finishedGoods: 'finishedGoods', rawMaterials: 'rawMaterials', accessories: 'accessories', tools: 'tools',
    lines: 'line', parameters: 'parameter', gates: 'gate', yard: 'yard', haulers: 'hauler',
    metasheets: 'metasheets', tutorials: 'tutorial', announcements: 'announcement', contacts: 'contact',
};
const DATASETS = Object.keys(COLLECTIONS);
const DEPENDENCIES = { workSchedule: 'schedules', workScheduleTemplate: 'schedules', config: 'configuration',
    user: 'users', calendarEvent: 'calendar', calendarTask: 'calendar', topic: 'messages', message: 'messages', passcode: 'passcodes' };
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const PAGE_SIZE = 500;
const MAX_BYTES = 4 * 1024 * 1024;
const CAPTURE_BATCH_SIZE = 100;
// Isolated metadata lets older servers finish their v1 capture during a rolling deployment.
const STATE_ID = 'application-data-v2';
const JOURNAL = 'syncJournalV2';
const DATE_SCOPED = new Set(['timecards', 'inbound', 'outbound', 'haulers']);

class SyncError extends Error {
    constructor(code, message) { super(message); this.code = code; }
}

const cursorFor = (dataset, state, scope, business) => ({ dataset,
    generation: DATE_SCOPED.has(dataset) ? `${state.generation}:${business.timeZone}` : state.generation,
    sequence: state.head, scope });
const byteSize = value => Buffer.byteLength(JSON.stringify(value));

// Raw collections keep this service independent of model import side effects and test databases.
function createDataSync({ connection, getBusinessContext, notify = () => {}, logger = console, leaseMs = 15000, maxBytes = MAX_BYTES }) {
    const owner = randomUUID();
    const states = () => connection.db.collection('syncState');
    const journal = () => connection.db.collection(JOURNAL);
    let initializing;
    let stopped = true;
    let worker;
    let stream;
    let lease;
    let lastPrune = 0;
    let pruneIndex = 0;
    let wake;
    let observedHeads = '';
    let sourceClockOffset = 0;
    let lastClockSample = 0;

    const initialize = () => initializing ||= (async () => {
        await connection.asPromise();
        await journal().createIndex({ dataset: 1, generation: 1, sequence: 1 }, { unique: true });
        await journal().createIndex({ capturedAt: 1 });
        const hello = await connection.db.admin().command({ hello: 1 });
        const operationTime = hello.operationTime || hello.$clusterTime?.clusterTime;
        if (!operationTime) throw new SyncError('UNAVAILABLE', 'Sync requires a MongoDB replica set');
        const datasets = Object.fromEntries(DATASETS.map(name => [name, {
            generation: randomUUID(), head: 0, retainedAfter: 0, clusterTime: operationTime,
        }]));
        try {
            await states().updateOne({ _id: STATE_ID }, { $setOnInsert: {
                datasets, operationTime, checkpoint: null, fence: 0, owner: null,
                leaseUntil: new Date(0), lastPollAt: null, lastEventAt: null, error: null,
            } }, { upsert: true, writeConcern: { w: 'majority' } });
        } catch (error) {
            if (error.code !== 11000) throw error;
        }
        await states().updateOne({ _id: STATE_ID, dependencies: { $exists: false } }, {
            $set: { dependencies: Object.fromEntries(Object.values(DEPENDENCIES).map(name => [name, randomUUID()])) },
        }, { writeConcern: { w: 'majority' } });
    })().catch(error => { initializing = null; throw error; });

    const readState = async session => {
        const state = await states().findOne({ _id: STATE_ID }, { session, readConcern: { level: 'majority' } });
        if (state) return state;
        initializing = null;
        throw new SyncError('UNAVAILABLE', 'Sync metadata was replaced; rebuilding capture');
    };
    const leaseFilter = () => ({ _id: STATE_ID, owner, fence: lease.fence, leaseUntil: { $gt: new Date() } });
    const healthy = state => !!state?.lastPollAt && !state.error && state.leaseUntil > new Date()
        && Date.now() - state.lastPollAt.getTime() < leaseMs * 2
        && Date.now() - (state.capturedThroughAt || state.lastPollAt).getTime() < leaseMs * 2;

    const transaction = async action => {
        const session = connection.startSession ? await connection.startSession() : connection.client.startSession();
        try {
            return await session.withTransaction(async () => {
                const state = await states().findOne(leaseFilter(), { session });
                if (!state) throw new SyncError('LEASE_LOST', 'Sync consumer lease changed');
                return action(state, session);
            }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
        } finally { await session.endSession(); }
    };

    const writeState = async (patch, session) => {
        const result = await states().updateOne(leaseFilter(), { $set: patch }, { session });
        if (!result.matchedCount) throw new SyncError('LEASE_LOST', 'Sync consumer lease expired before commit');
    };

    const record = changes => transaction(async (state, session) => {
        const tokens = changes.map(change => createHash('sha256').update(JSON.stringify(change._id)).digest('hex'));
        const existing = await journal().find({ _id: { $in: tokens } }, { session, projection: { _id: 1 } }).toArray();
        const seen = new Set(existing.map(entry => entry._id));
        const entries = [];
        for (const [index, change] of changes.entries()) {
            const tokenId = tokens[index];
            if (seen.has(tokenId)) continue;
            seen.add(tokenId);
            const dataset = DATASETS.find(name => COLLECTIONS[name] === change.ns?.coll);
            const documentChange = ['insert', 'update', 'replace', 'delete'].includes(change.operationType);
            const dependencies = ['dropDatabase', 'invalidate'].includes(change.operationType)
                ? Object.values(DEPENDENCIES) : [DEPENDENCIES[change.ns?.coll], DEPENDENCIES[change.to?.coll]].filter(Boolean);
            for (const name of dependencies) state.dependencies[name] = randomUUID();
            if (dataset && documentChange) {
                const info = state.datasets[dataset];
                if (!Number.isSafeInteger(info.head + 1)) throw new SyncError('SEQUENCE_EXHAUSTED', 'Sync sequence exhausted');
                entries.push({ _id: tokenId, dataset, generation: info.generation,
                    sequence: ++info.head, recordId: change.documentKey._id, sourceToken: change._id,
                    clusterTime: change.clusterTime, capturedAt: new Date() });
                info.clusterTime = change.clusterTime;
            } else if (!documentChange) {
                const affected = ['dropDatabase', 'invalidate'].includes(change.operationType) ? DATASETS
                    : DATASETS.filter(name => [change.ns?.coll, change.to?.coll].includes(COLLECTIONS[name]));
                for (const name of affected) state.datasets[name] = {
                    generation: randomUUID(), head: 0, retainedAfter: 0, clusterTime: change.clusterTime,
                };
                logger.warn('[DataSync] Dataset generation reset', { reason: change.operationType, datasets: affected });
            }
            const userProjectionChanged = dependencies.includes('users') && (change.operationType !== 'update'
                || [...Object.keys(change.updateDescription?.updatedFields || {}), ...(change.updateDescription?.removedFields || [])]
                    .some(field => ['displayName', 'username'].includes(field)));
            if (userProjectionChanged) {
                const business = await getBusinessContext();
                const referenced = await connection.db.collection(COLLECTIONS.timecards).findOne({ date: business.businessDate,
                    'overtime.approvedBy': change.documentKey?._id || { $exists: true, $ne: null },
                }, { session, projection: { _id: 1 } });
                if (referenced) state.datasets.timecards = { generation: randomUUID(), head: 0, retainedAfter: 0, clusterTime: change.clusterTime };
            }
        }
        if (entries.length) await journal().insertMany(entries, { session });
        await writeState({ datasets: state.datasets, dependencies: state.dependencies,
            checkpoint: changes.at(-1)._id, lastEventAt: new Date(), error: null }, session);
    });

    const resetHistory = () => transaction(async (state, session) => {
        const hello = await connection.db.admin().command({ hello: 1 });
        const operationTime = hello.operationTime || hello.$clusterTime.clusterTime;
        const datasets = Object.fromEntries(DATASETS.map(name => [name, {
            generation: randomUUID(), head: 0, retainedAfter: 0, clusterTime: operationTime,
        }]));
        await writeState({ datasets, checkpoint: null, operationTime,
            dependencies: Object.fromEntries(Object.values(DEPENDENCIES).map(name => [name, randomUUID()])),
            lastPollAt: null, error: 'Rebuilding change-stream checkpoint' }, session);
        logger.warn('[DataSync] Dataset generations reset: source history unavailable');
    });

    const prune = async () => {
        const cutoff = new Date(Date.now() - RETENTION_MS);
        if (pruneIndex < DATASETS.length) {
            const dataset = DATASETS[pruneIndex];
            await transaction(async (state, session) => {
                const info = state.datasets[dataset];
                const entries = await journal().find({ dataset, generation: info.generation,
                    sequence: { $gt: info.retainedAfter } }, { session }).sort({ sequence: 1 }).limit(PAGE_SIZE).toArray();
                let boundary = info.retainedAfter;
                for (const entry of entries) {
                    if (entry.capturedAt >= cutoff) break;
                    boundary = entry.sequence;
                }
                if (boundary === info.retainedAfter) return;
                await writeState({ [`datasets.${dataset}.retainedAfter`]: boundary }, session);
                await journal().deleteMany({ dataset, generation: info.generation, sequence: { $lte: boundary } }, { session });
            });
            pruneIndex++;
            return;
        }
        // Old generations are never replayable; bounded cleanup does not change current boundaries.
        const state = await readState();
        const old = await journal().find({ capturedAt: { $lt: cutoff }, $nor: DATASETS.map(dataset => ({
            dataset, generation: state.datasets[dataset].generation,
        })) }).limit(PAGE_SIZE).project({ _id: 1 }).toArray();
        if (old.length) await journal().deleteMany({ _id: { $in: old.map(item => item._id) } });
        pruneIndex = 0;
        lastPrune = Date.now();
    };

    const wait = () => new Promise(resolve => {
        const timer = setTimeout(() => { wake = null; resolve(); }, 1000);
        wake = () => { clearTimeout(timer); wake = null; resolve(); };
    });

    const observe = async () => {
        const state = await readState();
        const signature = JSON.stringify([state.dependencies, DATASETS.map(name => [name, state.datasets[name].generation, state.datasets[name].head])]);
        if (signature !== observedHeads) { observedHeads = signature; notify(); }
    };

    const run = async () => {
        while (!stopped) {
            try {
                await initialize();
                if (!lease) {
                    lease = await states().findOneAndUpdate({ _id: STATE_ID, leaseUntil: { $lte: new Date() } }, {
                        $set: { owner, leaseUntil: new Date(Date.now() + leaseMs), lastPollAt: null }, $inc: { fence: 1 },
                    }, { returnDocument: 'after', includeResultMetadata: false, writeConcern: { w: 'majority' } });
                    if (!lease) { await observe(); await wait(); continue; }
                    const names = [...Object.values(COLLECTIONS), ...Object.keys(DEPENDENCIES)];
                    stream = connection.db.watch([{ $match: { $or: [
                        { 'ns.coll': { $in: names } }, { 'to.coll': { $in: names } },
                        { operationType: { $in: ['dropDatabase', 'invalidate'] } },
                    ] } }, { $project: { fullDocument: 0, fullDocumentBeforeChange: 0 } }], {
                        maxAwaitTimeMS: Math.min(250, Math.floor(leaseMs / 4)), batchSize: CAPTURE_BATCH_SIZE, ...(lease.checkpoint
                        ? { resumeAfter: lease.checkpoint } : { startAtOperationTime: lease.operationTime }) });
                }
                if (Date.now() - lastClockSample >= 1000) {
                    const hello = await connection.db.admin().command({ hello: 1 });
                    sourceClockOffset = hello.localTime ? hello.localTime.getTime() - Date.now() : 0;
                    lastClockSample = Date.now();
                }
                // A bounded, ordered batch commits its journal entries and checkpoint atomically.
                const batchStarted = Date.now();
                const changes = [];
                do {
                    const change = await stream.tryNext();
                    if (!change) break;
                    changes.push(change);
                } while (!stopped && changes.length < CAPTURE_BATCH_SIZE && Date.now() - batchStarted < 25);
                if (changes.length) await record(changes);
                const change = changes.at(-1);
                const now = Date.now();
                const sourceTime = change && (change.wallTime?.getTime() ?? change.clusterTime.getHighBitsUnsigned() * 1000);
                const lagMs = change ? Math.max(0, now + sourceClockOffset - sourceTime) : 0;
                const patch = { leaseUntil: new Date(now + leaseMs), lastPollAt: new Date(now), capturedThroughAt: new Date(now - lagMs) };
                if (!change) Object.assign(patch, { error: null,
                    ...(stream.resumeToken ? { checkpoint: stream.resumeToken } : {}) });
                const renewed = await states().updateOne(leaseFilter(), { $set: patch }, { writeConcern: { w: 'majority' } });
                if (!renewed.matchedCount) throw new SyncError('LEASE_LOST', 'Sync consumer lease changed');
                await observe();
                if (changes.length && (now - batchStarted > 1000 || lagMs > leaseMs))
                    logger.info('[DataSync] Capture batch', { events: changes.length, elapsedMs: now - batchStarted, lagMs });
                // Interleave one bounded cleanup step with capture so a full retention sweep cannot starve the lease.
                if (Date.now() - lastPrune > 60000) await prune();
            } catch (error) {
                logger.error('[DataSync] Capture unavailable:', error.code, error.message);
                if (lease) {
                    try {
                        if ([136, 260, 280, 286].includes(error.code) || error.code === 'SEQUENCE_EXHAUSTED') await resetHistory();
                        else await states().updateOne(leaseFilter(), { $set: { error: error.message, lastPollAt: null } });
                        await states().updateOne({ _id: STATE_ID, owner, fence: lease.fence }, { $set: { leaseUntil: new Date(0) } });
                    } catch (failure) { logger.error('[DataSync] Recovery:', failure.message); }
                }
                await stream?.close().catch(() => {});
                stream = null;
                lease = null;
                if (!stopped) await wait();
            }
        }
    };

    const status = async () => {
        await initialize();
        const state = await readState();
        const business = await getBusinessContext();
        // Scheduled configuration can become effective without another database write.
        const now = new Date();
        const effective = await connection.db.collection('config').find({ status: 'Active',
            'effective.from': { $lte: now }, $or: [{ 'effective.to': null }, { 'effective.to': { $gte: now } }],
        }, { projection: { _id: 1 }, readConcern: { level: 'majority' } }).sort({ _id: 1 }).toArray();
        const configuration = `${state.dependencies.configuration}:${createHash('sha256').update(JSON.stringify(effective)).digest('hex')}`;
        return { protocolVersion: 1, workingSetVersion: 2, ...business, serverTime: new Date().toISOString(),
            dependencies: { ...state.dependencies, configuration },
            capture: { available: healthy(state), lastPollAt: state.lastPollAt,
                lastEventAt: state.lastEventAt,
                pollAgeMs: state.lastPollAt ? Math.max(0, Date.now() - state.lastPollAt.getTime()) : null,
                lagMs: state.capturedThroughAt ? Math.max(0, Date.now() - state.capturedThroughAt.getTime()) : null },
            datasets: Object.fromEntries(DATASETS.map(name => [name, {
                ...cursorFor(name, state.datasets[name], DATE_SCOPED.has(name) ? business.businessDate : 'all', business),
                retainedAfter: state.datasets[name].retainedAfter,
            }])) };
    };

    const validate = (dataset, scope, cursor, state, business) => {
        if (DATE_SCOPED.has(dataset) && scope !== business.businessDate)
            throw new SyncError('RESET_REQUIRED', 'Sync scope changed');
        const info = state.datasets[dataset];
        if (!info || !DATASETS.includes(dataset)) throw new SyncError('INVALID_REQUEST', 'Unknown sync dataset');
        if (!cursor || cursor.dataset !== dataset || cursor.scope !== scope || cursor.generation !== cursorFor(dataset, info, scope, business).generation
            || !Number.isSafeInteger(cursor.sequence) || cursor.sequence < info.retainedAfter || cursor.sequence > info.head)
            throw new SyncError('RESET_REQUIRED', 'Dataset snapshot required');
    };

    const beginRead = async (dataset, scope) => {
        await initialize();
        if (!DATASETS.includes(dataset)) throw new SyncError('INVALID_REQUEST', 'Unknown sync dataset');
        const business = await getBusinessContext();
        if (scope !== (DATE_SCOPED.has(dataset) ? business.businessDate : 'all'))
            throw new SyncError('RESET_REQUIRED', 'Sync scope changed');
        const session = connection.client.startSession({ causalConsistency: true });
        try {
            const state = await readState(session);
            if (!healthy(state)) throw new SyncError('UNAVAILABLE', 'Database change capture is catching up');
            if (state.datasets[dataset].clusterTime) session.advanceOperationTime(state.datasets[dataset].clusterTime);
            return { state, session, business };
        } catch (error) { await session.endSession(); throw error; }
    };

    const queryRecords = async (dataset, scope, filter, session, limit, business) => {
        const query = { ...filter };
        if (dataset === 'employees' || dataset === 'timecards') query.isDeleted = { $ne: true };
        if (dataset === 'timecards') query.date = scope;
        if (dataset === 'haulers') query.date = scope;
        const dayStart = DATE_SCOPED.has(dataset) ? dayjs.tz(scope, business.timeZone).startOf('day').toDate() : null;
        if (dataset === 'inbound') query.$or = [
            { status: { $ne: 'Completed' } }, { status: 'Completed', 'receipt.uploadedAt': { $gte: dayStart } },
        ];
        const readOptions = {
            session, readConcern: { level: 'majority' }, readPreference: 'primary',
        };
        const collection = connection.db.collection(COLLECTIONS[dataset]);
        let records = dataset === 'outbound' ? await collection.aggregate([
            { $match: query },
            { $set: { loads: { $filter: {
                input: { $cond: [{ $gt: [{ $size: { $ifNull: ['$loads', []] } }, 0] }, '$loads', [{}]] },
                as: 'load', cond: { $let: { vars: { row: { $mergeObjects: ['$$ROOT', '$$load'] } }, in: { $or: [
                    { $ne: ['$$row.status', 'Completed'] }, { $gte: ['$$row.pickupDate', scope] },
                    { $gte: ['$$row.schedulePickupAt', dayStart] },
                    { $and: [{ $in: [{ $ifNull: ['$$row.bol.url', ''] }, ['', null]] },
                        ...['carrierSCAC', 'executingSCAC', 'assignedSCAC'].map(key => ({ $ne: [`$$row.${key}`, 'DMSP'] }))] },
                ] } } },
            } } } },
            { $match: { 'loads.0': { $exists: true } } }, { $sort: { _id: 1 } }, { $limit: limit },
        ], readOptions).toArray() : await collection.find(query, readOptions).sort({ _id: 1 }).limit(limit).toArray();
        // List endpoints return hydrated master records; preserve their schema defaults/serialization.
        const Model = Object.values(connection.models).find(model => model.collection.name === COLLECTIONS[dataset]);
        if (Model && !['timecards', 'orders', 'outbound', 'inbound'].includes(dataset)) records = records.map(record => Model.hydrate(record).toJSON());
        if (dataset === 'orders') records = records.map(({ productionLogs, buyers, ...record }) => ({ ...record,
            buyers: (buyers || []).map(buyer => Object.fromEntries([
                'poNumber', 'poDate', 'masterPO', 'name', 'address', 'city', 'state', 'zip', 'country', 'done', 'status', 'shipWindow',
            ].filter(key => buyer[key] !== undefined).map(key => [key, buyer[key]]))),
        }));
        // Match timecard:fetch's populated approver shape.
        if (dataset === 'timecards') {
            const ids = records.flatMap(record => record.overtime?.approvedBy ? [record.overtime.approvedBy] : []);
            const users = ids.length ? await connection.db.collection('user').find({ _id: { $in: ids } }, {
                session, readConcern: { level: 'majority' }, projection: { displayName: 1, username: 1 },
            }).toArray() : [];
            for (const record of records) if (record.overtime?.approvedBy)
                record.overtime.approvedBy = users.find(user => String(user._id) === String(record.overtime.approvedBy)) || null;
        }
        return records;
    };

    const snapshot = async ({ dataset, scope, baseline, afterId } = {}) => {
        const { state, session, business } = await beginRead(dataset, scope);
        try {
            const cursor = baseline || cursorFor(dataset, state.datasets[dataset], scope, business);
            validate(dataset, scope, cursor, state, business);
            if (afterId != null && (typeof afterId !== 'string' || !/^[a-f\d]{24}$/i.test(afterId)))
                throw new SyncError('INVALID_REQUEST', 'Invalid snapshot page key');
            const ObjectId = connection.base.mongo.ObjectId;
            const records = await queryRecords(dataset, scope, afterId ? { _id: { $gt: new ObjectId(afterId) } } : {}, session, PAGE_SIZE + 1, business);
            const page = { dataset, baseline: cursor, upserts: [], afterId: null, hasMore: false };
            let pageBytes = byteSize(page);
            for (const record of records.slice(0, PAGE_SIZE)) {
                const recordBytes = byteSize(record);
                if (recordBytes + 2048 > maxBytes) throw new SyncError('RECORD_TOO_LARGE', 'A sync record exceeds the package limit');
                if (pageBytes + recordBytes + 256 > maxBytes) break;
                pageBytes += recordBytes + (page.upserts.length ? 1 : 0);
                page.upserts.push(record);
            }
            page.hasMore = records.length > page.upserts.length;
            page.afterId = page.upserts.length ? String(page.upserts.at(-1)._id) : null;
            validate(dataset, scope, cursor, await readState(session), await getBusinessContext());
            return page;
        } finally { await session.endSession(); }
    };

    const pull = async ({ dataset, scope, cursor, targetCursor } = {}) => {
        const { state, session, business } = await beginRead(dataset, scope);
        try {
            validate(dataset, scope, cursor, state, business);
            const target = targetCursor || cursorFor(dataset, state.datasets[dataset], scope, business);
            validate(dataset, scope, target, state, business);
            if (target.sequence < cursor.sequence) throw new SyncError('INVALID_REQUEST', 'Sync target precedes cursor');
            const entries = await journal().find({ dataset, generation: state.datasets[dataset].generation,
                sequence: { $gt: cursor.sequence, $lte: target.sequence } }, { session, readConcern: { level: 'majority' } })
                .sort({ sequence: 1 }).limit(PAGE_SIZE).toArray();
            if (entries.length !== Math.min(PAGE_SIZE, target.sequence - cursor.sequence)
                || entries.some((entry, index) => entry.sequence !== cursor.sequence + index + 1))
                throw new SyncError('RESET_REQUIRED', 'Change journal is no longer contiguous');
            const records = entries.length ? await queryRecords(dataset, scope, { _id: { $in: entries.map(entry => entry.recordId) } }, session, PAGE_SIZE, business) : [];
            const byId = new Map(records.map(record => [String(record._id), record]));
            const page = { dataset, fromCursor: cursor, nextCursor: cursor, targetCursor: target,
                upserts: [], removes: [], hasMore: false };
            let pageBytes = byteSize(page);
            const included = new Set();
            for (const entry of entries) {
                const id = String(entry.recordId);
                const record = byId.get(id);
                if (!included.has(id)) {
                    const recordBytes = byteSize(record || id);
                    if (recordBytes + 2048 > maxBytes) throw new SyncError('RECORD_TOO_LARGE', 'A sync record exceeds the package limit');
                    if (pageBytes + recordBytes + 256 > maxBytes) break;
                    pageBytes += recordBytes + ((record ? page.upserts : page.removes).length ? 1 : 0);
                    record ? page.upserts.push(record) : page.removes.push(id);
                    included.add(id);
                }
                pageBytes += String(entry.sequence).length - String(page.nextCursor.sequence).length;
                page.nextCursor = { ...cursor, sequence: entry.sequence };
            }
            page.hasMore = page.nextCursor.sequence < target.sequence;
            validate(dataset, scope, cursor, await readState(session), await getBusinessContext());
            logger.info('[DataSync] Delta', { dataset, scanned: page.nextCursor.sequence - cursor.sequence,
                upserts: page.upserts.length, removes: page.removes.length, bytes: byteSize(page) });
            return page;
        } finally { await session.endSession(); }
    };

    return { status, snapshot, pull, initialize,
        start() { if (!stopped) return; stopped = false; worker = run(); },
        async stop() {
            stopped = true; wake?.(); await stream?.close().catch(() => {}); await worker;
            if (lease) await states().updateOne({ _id: STATE_ID, owner, fence: lease.fence }, { $set: { leaseUntil: new Date(0), lastPollAt: null } });
            lease = null;
        },
    };
}

module.exports = { createDataSync, SyncError, DATASETS, COLLECTIONS, RETENTION_MS, JOURNAL, STATE_ID };
