const assert = require('node:assert/strict');
const test = require('node:test');
const mongoose = require('mongoose');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createServer } = require('node:http');
const { Server } = require('socket.io');
const { io: connectClient } = require('../../client/node_modules/socket.io-client');
const { createDataSync, DATASETS, RETENTION_MS } = require('../utils/dataSync');

const uri = process.env.DATA_SYNC_TEST_URI;
const quiet = { info() {}, warn() {}, error() {} };
const waitFor = async (predicate, timeout = 15000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
        const value = await predicate();
        if (value) return value;
        await new Promise(resolve => setTimeout(resolve, 30));
    }
    throw new Error('Timed out waiting for sync');
};
const wire = value => JSON.parse(JSON.stringify(value));

async function fixture(t, options = {}) {
    assert.match(uri, /^mongodb:\/\/(127\.0\.0\.1|localhost):\d+\/data_sync_test_[a-z\d_]+(?:\?|$)/i);
    const connection = await mongoose.createConnection(uri, { dbName: `data_sync_test_${randomUUID().replaceAll('-', '')}` }).asPromise();
    let businessDate = '2026-09-07';
    let notifications = 0;
    const config = { connection, getBusinessContext: async () => ({ businessDate, timeZone: 'America/New_York' }),
        notify: () => notifications++, logger: quiet, ...options };
    const services = [];
    const start = () => { const service = (options.serviceFactory || createDataSync)(config); services.push(service); service.start(); return service; };
    const sync = start();
    t.after(async () => { for (const service of services) await service.stop(); await connection.close(); });
    await waitFor(async () => (await sync.status()).capture.available);
    const current = name => waitFor(async () => {
        const status = await sync.status();
        return status.capture.available && status.datasets[name];
    });
    const catchUp = (name, sequence) => waitFor(async () => {
        const status = await sync.status();
        return status.capture.available && status.datasets[name].sequence >= sequence && status.datasets[name];
    });
    const client = async (name = 'employees') => {
        const scope = ['timecards', 'inbound', 'outbound', 'haulers'].includes(name) ? businessDate : 'all';
        const records = new Map();
        const snap = wire(await sync.snapshot({ dataset: name, scope }));
        assert.equal(snap.hasMore, false);
        for (const record of snap.upserts) records.set(record._id, record);
        let cursor = snap.baseline;
        const recover = async () => {
            const packages = [];
            let targetCursor;
            do {
                const page = wire(await sync.pull({ dataset: name, scope, cursor, targetCursor }));
                for (const id of page.removes) records.delete(id);
                for (const record of page.upserts) records.set(record._id, record);
                cursor = page.nextCursor; targetCursor = page.targetCursor;
                packages.push(page);
                if (!page.hasMore) return packages;
            } while (true);
        };
        await recover();
        return { records, recover, get cursor() { return cursor; } };
    };
    return { sync, connection, start, current, catchUp, client,
        setDate: date => { businessDate = date; }, get notifications() { return notifications; } };
}

test('dataset names are a fixed allowlist', () => {
    assert.ok(['employees', 'departments', 'positions', 'timecards', 'orders', 'inbound', 'outbound', 'products', 'finishedGoods'].every(name => DATASETS.includes(name)));
    assert.equal(new Set(DATASETS).size, DATASETS.length);
});

test('offline punch commands commit once, use capture date, and retain receipts after deletion', { skip: !uri }, async t => {
    const f = await fixture(t);
    const dayjs = require('dayjs');
    dayjs.extend(require('dayjs/plugin/utc'));
    dayjs.extend(require('dayjs/plugin/timezone'));
    dayjs.getFactoryTimeZone = async () => 'America/New_York';
    f.connection.model('employee', new mongoose.Schema({}, { strict: false }), 'employee');
    const module = { exports: {} };
    const source = fs.readFileSync(path.join(__dirname, '../models/timecard.js'), 'utf8');
    vm.runInNewContext(source.slice(0, source.indexOf('Timecard.watch(')) + 'module.exports = Timecard;', {
        module, console, require: name => {
            if (name === '../utils/dayjs') return dayjs;
            if (name === '../config/database') return f.connection;
            if (name === '../socket/io') return { io: {} };
            return require(name);
        },
    });
    const Timecard = module.exports;
    await Timecard.init();
    const employeeId = new mongoose.Types.ObjectId();
    const command = { _id: String(employeeId), eventId: 'offline-midnight', capturedAt: '2026-09-08T03:59:00Z' };
    const receipts = await Promise.all(Array.from({ length: 5 }, () => Timecard.clockIn(command)));
    assert.ok(receipts.every(receipt => receipt.committed && receipt.commandId === command.eventId));
    assert.equal(new Set(receipts.map(receipt => receipt._id)).size, 1);
    let card = await Timecard.findById(receipts[0]._id).lean();
    assert.equal(card.date, '2026-09-07');
    assert.equal(card.punches.length, 1);
    assert.equal(await Timecard.countDocuments(), 1);
    assert.deepEqual(wire(await Timecard.clockIn({ ...command, _id: command._id.toUpperCase() })), wire(receipts[0]));
    await assert.rejects(Timecard.clockIn({ ...command, capturedAt: '2026-09-09T05:00:00Z' }), { code: 'CONFLICT' });
    await assert.rejects(Timecard.clockOut({ ...command, _id: String(new mongoose.Types.ObjectId()), eventId: 'missing-card' }), { code: 'NOT_FOUND' });
    await assert.rejects(Timecard.clockIn({ ...command, capturedAt: 'invalid' }), { code: 'INVALID_COMMAND' });
    await assert.rejects(Timecard.clockIn(null), { code: 'INVALID_COMMAND' });

    const events = new Map();
    const socket = { rooms: new Set(['data-sync-v1']), on: (name, callback) => events.set(name, callback) };
    const handlerModule = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../socket/event/employee.js'), 'utf8'), {
        module: handlerModule, console, require: name => {
            if (name === '../../utils/dayjs') return dayjs;
            if (name === '../../models') return { timecard: Timecard };
            return require(name);
        },
    });
    handlerModule.exports(socket, {});
    const call = (event, payload) => new Promise(resolve => events.get(event)(payload, resolve));
    const missing = await call('timecard:clockOut', { _id: String(new mongoose.Types.ObjectId()), eventId: 'missing-socket-card' });
    assert.equal(missing.status, 'error');
    assert.equal(missing.payload.code, 'NOT_FOUND');
    assert.equal(missing.payload.retryable, false);
    const acknowledgement = await call('timecard:clockIn', command);
    assert.equal(acknowledgement.payload.commandId, command.eventId);
    socket.rooms.clear();
    const legacy = await call('timecard:clockIn', command);
    assert.equal(legacy.payload.punches.length, 1);

    await Promise.all([
        Timecard.breakStart({ _id: receipts[0]._id, eventId: 'break-start', capturedAt: '2026-09-08T04:10:00Z' }),
        Timecard.breakEnd({ _id: receipts[0]._id, eventId: 'break-end', capturedAt: '2026-09-08T04:20:00Z' }),
        Timecard.clockOut({ _id: receipts[0]._id, eventId: 'clock-out', capturedAt: '2026-09-08T05:00:00Z' }),
    ]);
    card = await Timecard.findById(receipts[0]._id).lean();
    assert.equal(card.punches.length, 4);
    assert.equal(new Set(card.processedEventIds).size, 4);

    const commands = f.connection.collection('timecardCommand');
    const insert = commands.insertOne.bind(commands);
    commands.insertOne = async (...args) => {
        if (args[0]._id === 'command:rollback') throw new Error('Simulated failure before receipt commit');
        return insert(...args);
    };
    await assert.rejects(Timecard.clockIn({ ...command, eventId: 'rollback' }), /Simulated failure/);
    assert.equal((await Timecard.findById(receipts[0]._id)).punches.length, 4);
    assert.equal(await commands.countDocuments({ _id: 'command:rollback' }), 0);
    commands.insertOne = insert;
    await Timecard.deleteOne({ _id: receipts[0]._id });
    assert.deepEqual(wire(await Timecard.clockIn(command)), wire(receipts[0]));
    assert.equal(await Timecard.countDocuments(), 0);

    const nextEmployee = String(new mongoose.Types.ObjectId());
    await Promise.all(['one', 'two'].map(eventId => Timecard.clockIn({ ...command, _id: nextEmployee, eventId })));
    assert.equal(await Timecard.countDocuments({ employeeId: nextEmployee }), 1);
    assert.equal((await Timecard.findOne({ employeeId: nextEmployee })).punches.length, 2);
});

test('direct schedule and config edits invalidate dependencies without reloading roster datasets', { skip: !uri }, async t => {
    const f = await fixture(t);
    const before = await f.sync.status();
    for (const name of ['workSchedule', 'workScheduleTemplate', 'config']) {
        const key = name === 'config' ? 'configuration' : 'schedules';
        const previous = (await f.sync.status()).dependencies[key];
        await f.connection.db.collection(name).insertOne({ name: 'Direct database change' });
        await waitFor(async () => (await f.sync.status()).dependencies[key] !== previous);
    }
    const after = await f.sync.status();
    assert.deepEqual(after.datasets, before.datasets);
    assert.notEqual(after.dependencies.schedules, before.dependencies.schedules);
    assert.notEqual(after.dependencies.configuration, before.dependencies.configuration);
});

test('two clients converge after direct edits, bulk writes, deletes and repeated updates', { skip: !uri }, async t => {
    const f = await fixture(t);
    const coll = f.connection.db.collection('employee');
    const a = await f.client();
    const b = await f.client();
    const headBefore = await f.current('departments');
    const ids = Array.from({ length: 4 }, () => new mongoose.Types.ObjectId());
    await coll.insertMany(ids.map((_id, index) => ({ _id, name: `Employee ${index}` })));
    await f.catchUp('employees', 4);
    await a.recover();
    await b.recover();
    await coll.updateOne({ _id: ids[0] }, { $set: { name: 'First edit' } });
    await coll.updateOne({ _id: ids[0] }, { $set: { name: 'Final edit' } });
    await coll.updateMany({ _id: { $in: [ids[0], ids[1]] } }, { $set: { index: 5 } });
    await coll.updateOne({ _id: ids[2] }, { $set: { isDeleted: true } });
    await coll.deleteOne({ _id: ids[3] });
    await f.catchUp('employees', 10);
    const packages = await a.recover();
    await b.recover();
    assert.equal(packages.length, 1);
    assert.equal(packages[0].upserts.length, 2);
    assert.equal(packages[0].removes.length, 2);
    assert.equal(a.records.get(String(ids[0])).name, 'Final edit');
    assert.deepEqual([...a.records], [...b.records]);
    assert.deepEqual(await f.current('departments'), headBefore);
    assert.equal((await a.recover())[0].upserts.length, 0);
    assert.ok(f.notifications > 0);
});

test('snapshot overlap, bounded packages, retries and fixed targets do not skip changes', { skip: !uri }, async t => {
    const f = await fixture(t, { maxBytes: 4500 });
    const coll = f.connection.db.collection('position');
    const initial = await f.current('positions');
    await coll.insertMany(Array.from({ length: 8 }, (_, index) => ({ name: `Position ${index}`, description: 'x'.repeat(800) })));
    await f.catchUp('positions', 8);
    let baseline;
    let afterId;
    let snapshotCount = 0;
    do {
        const page = wire(await f.sync.snapshot({ dataset: 'positions', scope: 'all', baseline, afterId }));
        baseline ||= page.baseline;
        assert.deepEqual(page.baseline, baseline);
        snapshotCount += page.upserts.length;
        if (!page.hasMore) break;
        afterId = page.afterId;
    } while (true);
    assert.equal(snapshotCount, 8);
    const first = await coll.findOne({});
    await coll.updateOne({ _id: first._id }, { $set: { name: 'Edited during snapshot' } });
    await f.catchUp('positions', 9);
    const replay = await f.sync.pull({ dataset: 'positions', scope: 'all', cursor: baseline });
    assert.equal(replay.upserts[0].name, 'Edited during snapshot');
    const firstPage = wire(await f.sync.pull({ dataset: 'positions', scope: 'all', cursor: initial }));
    assert.ok(firstPage.hasMore);
    assert.ok(Buffer.byteLength(JSON.stringify(firstPage)) < 4500);
    const retry = wire(await f.sync.pull({ dataset: 'positions', scope: 'all', cursor: initial, targetCursor: firstPage.targetCursor }));
    assert.deepEqual(retry, firstPage);
    await coll.insertOne({ name: 'After target' });
    await f.catchUp('positions', 10);
    let cursor = firstPage.nextCursor;
    while (cursor.sequence < firstPage.targetCursor.sequence) {
        const page = await f.sync.pull({ dataset: 'positions', scope: 'all', cursor, targetCursor: firstPage.targetCursor });
        assert.ok(page.nextCursor.sequence > cursor.sequence);
        cursor = page.nextCursor;
    }
    assert.equal(cursor.sequence, 9);
    const after = await f.sync.pull({ dataset: 'positions', scope: 'all', cursor });
    assert.equal(after.upserts[0].name, 'After target');
    await coll.insertOne({ name: 'Too big', description: 'x'.repeat(6000) });
    await f.catchUp('positions', 11);
    await assert.rejects(f.sync.pull({ dataset: 'positions', scope: 'all', cursor: after.nextCursor }), { code: 'RECORD_TOO_LARGE' });
});

test('current-day scope handles date moves, soft deletion, and factory midnight', { skip: !uri }, async t => {
    const f = await fixture(t);
    const cards = f.connection.db.collection('timecard');
    const id = new mongoose.Types.ObjectId();
    const historical = new mongoose.Types.ObjectId();
    const employeeId = new mongoose.Types.ObjectId();
    await cards.insertMany([{ _id: id, employeeId, date: '2026-09-07' }, { _id: historical, employeeId, date: '2026-09-06' }]);
    await f.catchUp('timecards', 2);
    const client = await f.client('timecards');
    assert.equal(client.records.size, 1);
    await cards.updateOne({ _id: id }, { $set: { date: '2026-09-06' } });
    await cards.updateOne({ _id: historical }, { $set: { date: '2026-09-07' } });
    await f.catchUp('timecards', 4);
    await client.recover();
    assert.equal(client.records.has(String(id)), false);
    assert.equal(client.records.has(String(historical)), true);
    await cards.updateOne({ _id: historical }, { $set: { isDeleted: true } });
    await f.catchUp('timecards', 5);
    await client.recover();
    assert.equal(client.records.size, 0);
    f.setDate('2026-09-08');
    await assert.rejects(client.recover(), { code: 'RESET_REQUIRED' });
    assert.equal((await f.sync.snapshot({ dataset: 'timecards', scope: '2026-09-08' })).upserts.length, 0);
});

test('consumer restart, duplicate source delivery and competing leases retain ordered history', { skip: !uri }, async t => {
    const f = await fixture(t);
    const coll = f.connection.db.collection('department');
    await coll.insertOne({ name: 'Before restart' });
    await f.catchUp('departments', 1);
    const cursor = await f.current('departments');
    const firstEntry = await f.connection.db.collection('syncJournalV2').findOne({ dataset: 'departments', sequence: 1 });
    await coll.insertOne({ name: 'Second' });
    await f.catchUp('departments', 2);
    await f.sync.stop();
    // Simulate recovery from an earlier checkpoint: the second event must be deduplicated.
    await f.connection.db.collection('syncState').updateOne({}, { $set: { checkpoint: firstEntry.sourceToken } });
    await coll.insertOne({ name: 'During downtime' });
    const replacement = f.start();
    const competitor = f.start();
    await waitFor(async () => {
        const status = await replacement.status();
        return status.capture.available && status.datasets.departments.sequence === 3;
    });
    const page = await competitor.pull({ dataset: 'departments', scope: 'all', cursor });
    assert.equal(page.upserts.length, 2);
    assert.equal(await f.connection.db.collection('syncJournalV2').countDocuments({ dataset: 'departments' }), 3);
    const seq = await f.connection.db.collection('syncJournalV2').find({ dataset: 'departments' }).sort({ sequence: 1 }).toArray();
    assert.deepEqual(seq.map(entry => entry.sequence), [1, 2, 3]);
});

test('retention expiry, holes, collection drop and bad scopes request explicit reset', { skip: !uri }, async t => {
    const f = await fixture(t);
    const cursor = await f.current('employees');
    const coll = f.connection.db.collection('employee');
    await coll.insertOne({ name: 'Old entry' });
    await f.catchUp('employees', 1);
    await f.sync.stop();
    await f.connection.db.collection('syncJournalV2').updateMany({}, { $set: { capturedAt: new Date(Date.now() - RETENTION_MS - 10000) } });
    const next = f.start();
    await waitFor(async () => {
        const status = await next.status();
        return status.capture.available && status.datasets.employees.retainedAfter === 1;
    });
    await assert.rejects(next.pull({ dataset: 'employees', scope: 'all', cursor }), { code: 'RESET_REQUIRED' });
    const retained = (await next.status()).datasets.employees;
    await coll.insertOne({ name: 'New entry' });
    await waitFor(async () => (await next.status()).datasets.employees.sequence === 2);
    await f.connection.db.collection('syncJournalV2').deleteOne({ dataset: 'employees', sequence: 2 });
    await assert.rejects(next.pull({ dataset: 'employees', scope: 'all', cursor: retained }), { code: 'RESET_REQUIRED' });
    await coll.drop();
    await waitFor(async () => (await next.status()).datasets.employees.generation !== retained.generation);
    await assert.rejects(next.snapshot({ dataset: 'employees', scope: 'all', baseline: retained }), { code: 'RESET_REQUIRED' });
    await assert.rejects(next.snapshot({ dataset: 'user', scope: 'all' }), { code: 'INVALID_REQUEST' });
    await assert.rejects(next.snapshot({ dataset: 'employees', scope: { $ne: '' } }), { code: 'RESET_REQUIRED' });
});

test('capture transaction rolls back a staged journal entry when the checkpoint write fails or loses its fence', { skip: !uri }, async t => {
    for (const mode of ['failure', 'lease']) await t.test(mode, async t => {
        let signal;
        const failed = new Promise(resolve => { signal = resolve; });
        const f = await fixture(t, { logger: { ...quiet, error: (...args) => signal(args) } });
        const original = f.connection.db.collection.bind(f.connection.db);
        let injected = false;
        f.connection.db.collection = name => {
            const collection = original(name);
            if (name !== 'syncState') return collection;
            const update = collection.updateOne.bind(collection);
            collection.updateOne = async (filter, operation, options) => {
                if (!injected && operation.$set?.checkpoint && operation.$set?.lastEventAt) {
                    injected = true;
                    if (mode === 'lease') return { matchedCount: 0 };
                    throw new Error('Injected checkpoint write failure');
                }
                return update(filter, operation, options);
            };
            return collection;
        };
        await original('employee').insertOne({ name: 'Recover atomically' });
        await failed;
        assert.equal(await original('syncJournalV2').countDocuments({ dataset: 'employees' }), 0);
        assert.equal((await original('syncState').findOne({})).datasets.employees.head, 0);
        await f.catchUp('employees', 1);
        assert.equal(await original('syncJournalV2').countDocuments({ dataset: 'employees' }), 1);
    });
});

test('unresumable source history rotates generations instead of silently skipping changes', { skip: !uri }, async t => {
    const f = await fixture(t);
    await f.connection.db.collection('employee').insertOne({ name: 'Still present after reset' });
    await f.catchUp('employees', 1);
    const old = (await f.sync.status()).datasets;
    await f.sync.stop();
    const watch = f.connection.db.watch.bind(f.connection.db);
    let fail = true;
    f.connection.db.watch = (...args) => {
        if (fail) { fail = false; throw Object.assign(new Error('ChangeStreamHistoryLost'), { code: 286 }); }
        return watch(...args);
    };
    const replacement = f.start();
    await waitFor(async () => {
        const status = await replacement.status();
        return status.capture.available && status.datasets.employees.generation !== old.employees.generation;
    });
    const next = await replacement.status();
    for (const name of DATASETS) assert.notEqual(next.datasets[name].generation, old[name].generation);
    await assert.rejects(replacement.pull({ dataset: 'employees', scope: 'all', cursor: old.employees }), { code: 'RESET_REQUIRED' });
    assert.equal((await replacement.snapshot({ dataset: 'employees', scope: 'all' })).upserts[0].name, 'Still present after reset');
});

test('real Socket.IO clients recover across disconnects using the production callback contract', { skip: !uri }, async t => {
    const http = createServer();
    const io = new Server(http, { path: '/sync-test', transports: ['websocket'] });
    const f = await fixture(t, { notify: () => io.to('data-sync-v1').emit('sync:changed') });
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../socket/event/sync.js'), 'utf8'), {
        module, require: name => { assert.equal(name, '../dataSync'); return f.sync; },
    });
    io.use((socket, next) => socket.handshake.auth?.appToken === 'sync-test' ? next() : next(new Error('Unauthorized')));
    io.on('connection', socket => module.exports(socket));
    await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
    const clients = [];
    t.after(async () => { for (const client of clients) client.disconnect(); await new Promise(resolve => io.close(resolve)); });
    const connect = async () => {
        const socket = connectClient(`http://127.0.0.1:${http.address().port}`, {
            path: '/sync-test', transports: ['websocket'], forceNew: true, auth: { appToken: 'sync-test' },
        });
        clients.push(socket);
        await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
        return socket;
    };
    const call = (socket, event, payload) => new Promise((resolve, reject) => socket.timeout(5000).emit(event, payload, (error, result) => {
        if (error) return reject(error);
        result.status === 'success' ? resolve(result.payload) : reject(Object.assign(new Error(result.message), result.payload));
    }));
    const a = await connect();
    const b = await connect();
    await call(a, 'sync:status', {});
    await call(b, 'sync:status', {});
    const baseline = (await call(b, 'sync:snapshot', { dataset: 'employees', scope: 'all' })).baseline;
    b.disconnect();
    const notice = new Promise(resolve => a.once('sync:changed', resolve));
    const inserted = await f.connection.db.collection('employee').insertOne({ name: 'While disconnected' });
    await f.catchUp('employees', 1);
    await notice;
    const aPage = await call(a, 'sync:pull', { dataset: 'employees', scope: 'all', cursor: baseline });
    const reconnected = new Promise(resolve => b.once('connect', resolve));
    b.connect(); await reconnected;
    await call(b, 'sync:status', {});
    const bPage = await call(b, 'sync:pull', { dataset: 'employees', scope: 'all', cursor: baseline });
    assert.deepEqual(aPage, bPage);
    assert.equal(bPage.upserts[0]._id, String(inserted.insertedId));
    await assert.rejects(call(b, 'sync:snapshot', { dataset: 'user', scope: 'all' }), { code: 'INVALID_REQUEST' });
});

test('master-record defaults and timecard approver projection match existing list endpoints', { skip: !uri }, async t => {
    const f = await fixture(t);
    f.connection.model('employee', new mongoose.Schema({ name: String, tags: [String], hiringStatus: { type: String, default: 'Incomplete' } }), 'employee');
    const approver = new mongoose.Types.ObjectId();
    await f.connection.db.collection('user').insertOne({ _id: approver, displayName: 'Supervisor', username: 'supervisor', password: 'never-projected' });
    await f.connection.db.collection('employee').insertOne({ name: 'Legacy employee' });
    await f.connection.db.collection('timecard').insertOne({ date: '2026-09-07', overtime: { approvedBy: approver } });
    await f.catchUp('employees', 1);
    await f.catchUp('timecards', 1);
    const employee = (await f.sync.snapshot({ dataset: 'employees', scope: 'all' })).upserts[0];
    assert.equal(employee.hiringStatus, 'Incomplete');
    assert.deepEqual(employee.tags, []);
    const timecard = (await f.sync.snapshot({ dataset: 'timecards', scope: '2026-09-07' })).upserts[0];
    assert.equal(timecard.overtime.approvedBy.displayName, 'Supervisor');
    assert.equal(timecard.overtime.approvedBy.password, undefined);
});


test('operational working sets recover direct writes, load removals and changes of date scope', { skip: !uri }, async t => {
    const f = await fixture(t);
    const outbound = f.connection.db.collection('outbound');
    const inbound = f.connection.db.collection('inbound');
    const haulers = f.connection.db.collection('hauler');
    const [a, b, c] = Array.from({ length: 3 }, () => new mongoose.Types.ObjectId());
    await outbound.insertMany([
        { _id: a, poNumber: 'active-parent', loads: [{ loadNumber: 'open', status: 'Scheduled' },
            { loadNumber: 'old', status: 'Completed', bol: { url: 'signed' }, pickupDate: '2026-09-06' },
            { loadNumber: 'today', status: 'Completed', bol: { url: 'signed' }, pickupDate: '2026-09-07' }] },
        { _id: b, status: 'Completed', carrierSCAC: 'DMSP', pickupDate: '2026-09-06', loads: [] },
        { _id: c, status: 'Completed', carrierSCAC: 'TRUCK', pickupDate: '2026-09-06', loads: [] },
    ]);
    await f.catchUp('outbound', 3);
    const client = await f.client('outbound');
    assert.equal(client.records.size, 2);
    assert.deepEqual(client.records.get(String(a)).loads.map(load => load.loadNumber), ['open', 'today']);
    assert.ok(client.records.has(String(c)), 'missing BOL remains in the working set');
    await outbound.updateOne({ _id: a }, { $pull: { loads: { loadNumber: 'open' } } });
    await outbound.updateOne({ _id: c }, { $set: { bol: { url: 'signed' } } });
    await f.catchUp('outbound', 5);
    const pages = await client.recover();
    assert.deepEqual(client.records.get(String(a)).loads.map(load => load.loadNumber), ['today']);
    assert.ok(pages.flatMap(page => page.removes).includes(String(c)));
    await inbound.insertMany([{ _id: a, status: 'Receiving' },
        { _id: b, status: 'Completed', receipt: { uploadedAt: new Date('2026-09-07T03:59:00Z') } },
        { _id: c, status: 'Completed', receipt: { uploadedAt: new Date('2026-09-07T04:00:00Z') } }]);
    await haulers.insertMany([{ _id: a, date: '2026-09-07' }, { _id: b, date: '2026-09-06' }]);
    await f.catchUp('inbound', 3); await f.catchUp('haulers', 2);
    const receiving = await f.client('inbound'), gate = await f.client('haulers');
    assert.deepEqual([...receiving.records.keys()].sort(), [String(a), String(c)].sort());
    assert.deepEqual([...gate.records.keys()], [String(a)]);
    await haulers.updateOne({ _id: a }, { $set: { date: '2026-09-06' } });
    await haulers.updateOne({ _id: b }, { $set: { date: '2026-09-07' } });
    await f.catchUp('haulers', 4); await gate.recover();
    assert.deepEqual([...gate.records.keys()], [String(b)]);
    f.setDate('2026-09-08');
    await assert.rejects(client.recover(), { code: 'RESET_REQUIRED' });
    const next = await f.client('outbound');
    assert.equal(next.records.size, 0);
});

test('order snapshots and deltas use the existing list projection and exclude production logs', { skip: !uri }, async t => {
    const f = await fixture(t);
    const orders = f.connection.db.collection('order');
    const id = new mongoose.Types.ObjectId();
    await orders.insertOne({ _id: id, poNumber: 'PO1', productionLogs: [{ detail: 'history' }],
        buyers: [{ name: 'Buyer', poNumber: 'B1', price: 42, address: 'Main Street' }] });
    await f.catchUp('orders', 1);
    const client = await f.client('orders');
    assert.equal(client.records.get(String(id)).productionLogs, undefined);
    assert.deepEqual(client.records.get(String(id)).buyers, [{ poNumber: 'B1', name: 'Buyer', address: 'Main Street' }]);
    await orders.updateOne({ _id: id }, { $set: { poNumber: 'PO2' } });
    await f.catchUp('orders', 2); await client.recover();
    assert.equal(client.records.get(String(id)).poNumber, 'PO2');
    assert.equal(client.records.get(String(id)).buyers[0].price, undefined);
    assert.equal(client.records.get(String(id)).productionLogs, undefined);
});

test('working-set v2 metadata coexists with v1 state during server rollout', { skip: !uri }, async t => {
    const f = await fixture(t);
    const state = f.connection.db.collection('syncState');
    await state.insertOne({ _id: 'employee-data-v1', sentinel: 'old-server' });
    const id = new mongoose.Types.ObjectId();
    await f.connection.db.collection('product').insertOne({ _id: id, styleCode: 'new' });
    await f.catchUp('products', 1);
    const client = await f.client('products');
    assert.equal(client.records.get(String(id)).styleCode, 'new');
    assert.equal((await state.findOne({ _id: 'employee-data-v1' })).sentinel, 'old-server');
    assert.equal(await f.connection.db.collection('syncJournal').countDocuments(), 0);
    assert.equal(await f.connection.db.collection('syncJournalV2').countDocuments({ dataset: 'products' }), 1);
});


test('scheduled configuration expiry changes status without a new source write', { skip: !uri }, async t => {
    const f = await fixture(t);
    const config = f.connection.db.collection('config');
    const state = f.connection.db.collection('syncState');
    const original = (await state.findOne({ _id: 'application-data-v2' })).dependencies.configuration;
    const expires = new Date(Date.now() + 3500);
    await config.insertOne({ _id: 'future-boundary', status: 'Active', effective: { from: new Date(0), to: expires } });
    await waitFor(async () => (await state.findOne({ _id: 'application-data-v2' })).dependencies.configuration !== original);
    const before = await f.sync.status();
    const captured = (await state.findOne({ _id: 'application-data-v2' })).dependencies.configuration;
    await new Promise(resolve => setTimeout(resolve, Math.max(0, expires.getTime() - Date.now() + 30)));
    const after = await f.sync.status();
    assert.notEqual(before.dependencies.configuration, after.dependencies.configuration);
    assert.equal((await state.findOne({ _id: 'application-data-v2' })).dependencies.configuration, captured);
    assert.equal(await config.countDocuments(), 1);
});

test('regression: capture health should stay available under a caught-up steady stream', { skip: !uri }, async t => {
 const f = await fixture(t, { leaseMs: 1500 });
 const collection = f.connection.db.collection('employee');
 let writes = 0;
 const until = Date.now() + 4500;
 while (Date.now() < until) {
   await collection.insertOne({ firstName: 'steady-' + writes++ });
   await new Promise(resolve => setTimeout(resolve, 20));
 }
 await waitFor(async () => (await f.connection.db.collection('syncState').findOne({ _id: 'application-data-v2' })).datasets.employees.head === writes);
 const status = await f.sync.status();
 console.log('REVIEW_STEADY', JSON.stringify({ writes, head: status.datasets.employees.sequence, capture: status.capture }));
 assert.equal(status.capture.available, true, 'all writes were captured but sync rejects reads until an idle poll');
});

test('regression: changing factory timezone must invalidate date-dependent membership', { skip: !uri }, async t => {
 let timeZone = 'America/Los_Angeles';
 const f = await fixture(t, { getBusinessContext: async () => ({ businessDate: '2026-09-07', timeZone }) });
 const id = new mongoose.Types.ObjectId();
 await f.connection.db.collection('inbound').insertOne({ _id: id, status: 'Completed', receipt: { uploadedAt: new Date('2026-09-07T05:00:00Z') } });
 await f.catchUp('inbound', 1);
 const initial = await f.sync.snapshot({ dataset: 'inbound', scope: '2026-09-07' });
 assert.equal(initial.upserts.length, 0);
 timeZone = 'America/New_York';
 const status = await f.sync.status();
 await assert.rejects(f.sync.pull({ dataset: 'inbound', scope: '2026-09-07', cursor: initial.baseline }), { code: 'RESET_REQUIRED' });
 const fresh = await f.sync.snapshot({ dataset: 'inbound', scope: '2026-09-07' });
 assert.notEqual(initial.baseline.generation, status.datasets.inbound.generation);
 assert.equal(fresh.upserts.length, 1, 'a scope reset must restore the newly eligible receipt');
});

test('edge: every subscribed collection converges after insert, replacement, update and hard deletion', { skip: !uri }, async t => {
    const { COLLECTIONS } = require('../utils/dataSync');
    const f = await fixture(t), clients = new Map();
    const ids = [new mongoose.Types.ObjectId(), new mongoose.Types.ObjectId(), new mongoose.Types.ObjectId()];
    for (const name of DATASETS) await f.connection.db.collection(COLLECTIONS[name]).insertMany(ids.slice(0, 2).map(_id => ({ _id, date: '2026-09-07', value: 'initial' })));
    await waitFor(async () => { const s = await f.sync.status(); return s.capture.available && DATASETS.every(name => s.datasets[name].sequence === 2); });
    for (const name of DATASETS) clients.set(name, await f.client(name));
    for (const name of DATASETS) await f.connection.db.collection(COLLECTIONS[name]).bulkWrite([
        { updateOne: { filter: { _id: ids[0] }, update: { $set: { value: 'updated' } } } },
        { replaceOne: { filter: { _id: ids[1] }, replacement: { _id: ids[1], date: '2026-09-07', value: 'replaced' } } },
        { deleteOne: { filter: { _id: ids[0] } } },
        { insertOne: { document: { _id: ids[2], date: '2026-09-07', value: 'inserted' } } },
    ]);
    await waitFor(async () => { const s = await f.sync.status(); return s.capture.available && DATASETS.every(name => s.datasets[name].sequence === 6); });
    for (const name of DATASETS) await t.test(name, async () => {
        const client = clients.get(name), pages = await client.recover();
        assert.equal(client.records.size, 2);
        assert.equal(client.records.has(String(ids[0])), false);
        assert.equal(client.records.get(String(ids[1])).value, 'replaced');
        assert.equal(client.records.get(String(ids[2])).value, 'inserted');
        assert.equal(client.cursor.sequence, 6);
        assert.ok(pages.every(page => Buffer.byteLength(JSON.stringify(page)) < 4 * 1024 * 1024));
    });
});

test('edge: 1200 mixed bulk operations recover identically for two clients across multiple journal pages', { skip: !uri }, async t => {
    const f = await fixture(t), collection = f.connection.db.collection('employee');
    const ids = Array.from({ length: 120 }, () => new mongoose.Types.ObjectId());
    await collection.insertMany(ids.map(_id => ({ _id, value: 0 })));
    await f.catchUp('employees', ids.length);
    const online = await f.client(), offline = await f.client();
    let seed = 9341, captured = ids.length;
    const random = max => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return Math.floor(seed / 65536) % max; };
    for (let round = 0; round < 4; round++) {
        const operations = Array.from({ length: 300 }, (_, i) => {
            const _id = ids[random(ids.length)], value = round * 300 + i + 1;
            return random(7) === 0 ? { deleteOne: { filter: { _id } } }
                : { updateOne: { filter: { _id }, update: { $set: { value, isDeleted: random(9) === 0 } }, upsert: true } };
        });
        const result = await collection.bulkWrite(operations);
        captured += result.deletedCount + result.modifiedCount + result.upsertedCount;
        await f.catchUp('employees', captured); await online.recover();
    }
    const pages = await offline.recover();
    assert.ok(pages.length >= 2);
    const sorted = records => wire([...records]).sort((a, b) => a._id.localeCompare(b._id));
    const expected = await collection.find({ isDeleted: { $ne: true } }).toArray();
    assert.deepEqual(sorted(online.records.values()), sorted(expected));
    assert.deepEqual(sorted(offline.records.values()), sorted(expected));
    assert.equal(offline.cursor.sequence, captured);
    assert.equal((await offline.recover())[0].upserts.length, 0);
});

test('edge: rename and replacement require generation recovery while unrelated cursors remain valid', { skip: !uri }, async t => {
    const f = await fixture(t), db = f.connection.db;
    await db.collection('employee').insertOne({ name: 'old' }); await f.catchUp('employees', 1);
    const before = await f.sync.status(), old = await f.client();
    await db.collection('replacementEmployee').insertOne({ name: 'replacement' });
    await db.collection('replacementEmployee').rename('employee', { dropTarget: true });
    await waitFor(async () => { const s = await f.sync.status(); return s.capture.available && s.datasets.employees.generation !== before.datasets.employees.generation; });
    await assert.rejects(old.recover(), { code: 'RESET_REQUIRED' });
    const fresh = await f.client(); assert.equal([...fresh.records.values()][0].name, 'replacement');
    assert.equal((await f.sync.status()).datasets.positions.generation, before.datasets.positions.generation);
});

test('edge: database replacement reinitializes metadata and recovers without restarting the process', { skip: !uri }, async t => {
    const f = await fixture(t);
    assert.match(f.connection.name, /^data_sync_test_[a-f\d]+$/);
    const before = await f.sync.status();
    await f.connection.db.dropDatabase();
    await f.connection.db.collection('employee').insertOne({ name: 'restored' });
    let lastError;
    const restored = await waitFor(async () => {
        try { const status = await f.sync.status(); return status.capture.available && status; }
        catch (error) { lastError = error.message; return null; }
    }, 6000).catch(() => null);
    assert.ok(restored, `metadata did not recover after isolated database replacement: ${lastError}`);
    assert.notEqual(restored.datasets.employees.generation, before.datasets.employees.generation);
    assert.equal([...((await f.client()).records.values())][0].name, 'restored');
});

test('edge: changing an approver refreshes the populated timecard projection', { skip: !uri }, async t => {
    const f = await fixture(t), db = f.connection.db;
    const user = new mongoose.Types.ObjectId();
    await db.collection('user').insertOne({ _id: user, displayName: 'Before', username: 'approver' });
    await db.collection('timecard').insertOne({ date: '2026-09-07', overtime: { approvedBy: user } });
    await f.catchUp('timecards', 1);
    const client = await f.client('timecards'), before = await f.sync.status();
    await db.collection('user').updateOne({ _id: user }, { $set: { displayName: 'After' } });
    await waitFor(async () => { const s = await f.sync.status(); return s.capture.available && s.dependencies.users !== before.dependencies.users; });
    await assert.rejects(client.recover(), { code: 'RESET_REQUIRED' });
    const fresh = await f.client('timecards');
    assert.equal([...fresh.records.values()][0].overtime.approvedBy.displayName, 'After');
    const after = await f.sync.status();
    assert.equal(after.datasets.employees.generation, before.datasets.employees.generation);
    await db.collection('user').updateOne({ _id: user }, { $set: { status: 'Active' } });
    await waitFor(async () => (await f.sync.status()).dependencies.users !== after.dependencies.users);
    assert.equal((await f.sync.status()).datasets.timecards.generation, after.datasets.timecards.generation);
});

for (const size of [0, 500, 501, 1001]) test(`edge: snapshot and delta page boundaries at ${size} records`, { skip: !uri }, async t => {
    const f = await fixture(t);
    if (size) await f.connection.db.collection('employee').insertMany(Array.from({ length: size }, (_, i) => ({ value: i })));
    await f.catchUp('employees', size);
    let baseline, afterId, count = 0, pages = 0;
    const seen = new Set();
    do {
        const page = wire(await f.sync.snapshot({ dataset: 'employees', scope: 'all', baseline, afterId }));
        assert.ok(page.upserts.length <= 500);
        if (baseline) assert.deepEqual(page.baseline, baseline);
        baseline = page.baseline; afterId = page.afterId; pages++;
        for (const record of page.upserts) { assert.equal(seen.has(record._id), false); seen.add(record._id); count++; }
        if (!page.hasMore) break;
        assert.ok(page.upserts.length > 0); assert.ok(pages < 10);
    } while (true);
    assert.equal(count, size); assert.equal(pages, Math.max(1, Math.ceil(size / 500)));
});

test('edge: real transport, client coordinator and encrypted checkpoints converge after restart and lost hints', { skip: !uri }, async t => {
    const Module = require('node:module');
    const loadClientFixture = (file, marker) => {
        const filename = path.resolve(__dirname, '../../client/test', file);
        const source = fs.readFileSync(filename, 'utf8');
        const loaded = new Module(filename, module);
        loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename));
        loaded._compile(source.slice(0, source.indexOf(marker)) + '\nmodule.exports = fixture;', filename);
        return loaded.exports;
    };
    const makeClient = loadClientFixture('employeeSync.test.cjs', "test('a successful unrelated");
    const makeCache = loadClientFixture('dataCache.test.cjs', "test('encrypted checkpoints");
    const cacheA = makeCache(), cacheB = makeCache();
    const http = createServer(), io = new Server(http, { transports: ['websocket'] });
    const f = await fixture(t);
    const collection = f.connection.db.collection('employee');
    const ids = [new mongoose.Types.ObjectId(), new mongoose.Types.ObjectId(), new mongoose.Types.ObjectId()];
    await collection.insertMany(ids.slice(0, 2).map((_id, i) => ({ _id, name: 'initial-' + i })));
    await f.catchUp('employees', 2);
    const handlerModule = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../socket/event/sync.js'), 'utf8'), {
        module: handlerModule, require: name => { assert.equal(name, '../dataSync'); return f.sync; },
    });
    io.on('connection', socket => handlerModule.exports(socket));
    await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
    const sockets = [];
    t.after(async () => { for (const socket of sockets) socket.disconnect(); await new Promise(resolve => io.close(resolve)); });
    const connect = async () => {
        const socket = connectClient(`http://127.0.0.1:${http.address().port}`, { transports: ['websocket'], forceNew: true });
        sockets.push(socket);
        await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
        return socket;
    };
    const socketA = await connect(), socketB = await connect();
    const transport = socket => (event, payload) => new Promise(resolve => socket.timeout(5000).emit(event, payload, (error, result) => {
        if (error) return resolve(['Socket timeout (5000ms)', null]);
        if (result.status !== 'success') return resolve([result.message, result.payload]);
        // The client fixture uses a controlled factory clock to make the test repeatable on any day.
        if (event === 'sync:status') result.payload.serverTime = '2026-09-07T15:00:00Z';
        resolve([null, result.payload]);
    }));
    const a = makeClient(t, { cache: cacheA.cache, hook: transport(socketA) });
    let b = makeClient(t, { cache: cacheB.cache, hook: transport(socketB) });
    assert.equal(await a.store.syncNow(), true); assert.equal(await b.store.syncNow(), true);
    const initialCursor = wire(b.store.states.employees.cursor);
    b.connected.value = false; socketB.disconnect();
    await collection.updateOne({ _id: ids[0] }, { $set: { name: 'changed offline' } });
    await collection.deleteOne({ _id: ids[1] });
    await collection.insertOne({ _id: ids[2], name: 'created offline' });
    await f.catchUp('employees', 5); await a.store.syncNow();
    assert.equal(b.collections.employees.find(row => row._id === String(ids[0])).name, 'initial-0');
    b.scope.stop();
    b = makeClient(t, { cache: cacheB.create('station-A', cacheB.secret), hook: transport(socketB) });
    b.connected.value = false; await b.store.syncNow();
    assert.equal(b.calls.length, 0);
    assert.equal(b.collections.employees.length, 2);
    assert.deepEqual(wire(b.store.states.employees.cursor), initialCursor);
    const reconnected = new Promise(resolve => socketB.once('connect', resolve)); socketB.connect(); await reconnected;
    b.connected.value = true; assert.equal(await b.store.syncNow(), true);
    const sorted = rows => wire(rows).sort((x, y) => x._id.localeCompare(y._id));
    assert.deepEqual(sorted(b.collections.employees), sorted(a.collections.employees));
    assert.equal(b.calls.filter(call => call.event === 'sync:snapshot').length, 0);
    assert.ok(b.calls.filter(call => call.event === 'sync:pull').every(call => call.payload.dataset === 'employees'));
    const saved = await cacheB.cache.read('employees');
    assert.equal(saved.cursor.sequence, 5); assert.deepEqual(sorted(saved.records), sorted(a.collections.employees));
    // No hints are delivered; only the coordinator's periodic status timer repairs this edit.
    await collection.updateOne({ _id: ids[0] }, { $set: { name: 'lost hint' } });
    await f.catchUp('employees', 6);
    await b.advance(30000); await b.advance(100);
    await waitFor(() => b.store.states.employees.cursor?.sequence === 6);
    assert.equal(b.collections.employees.find(row => row._id === String(ids[0])).name, 'lost hint');
});

test('edge: killing a capture process mid-batch allows fenced takeover without missing journal entries', { skip: !uri }, async t => {
    const { fork } = require('node:child_process');
    const f = await fixture(t, { leaseMs: 1500 });
    await f.sync.stop();
    const child = fork(path.join(__dirname, 'support/dataSyncWorker.cjs'), [uri, f.connection.name, 'hold-batch'], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
    let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Capture subprocess startup timeout: ' + stderr)), 10000);
        child.once('message', message => { clearTimeout(timer); message === 'ready' ? resolve() : reject(new Error(JSON.stringify(message))); });
        child.once('error', error => { clearTimeout(timer); reject(error); });
    });
    const old = await f.client();
    const staged = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('No capture batch was staged')), 10000);
        child.on('message', message => { if (message.batchStaged) { clearTimeout(timer); resolve(message.batchStaged); } });
    });
    await f.connection.db.collection('employee').insertMany(Array.from({ length: 400 }, (_, index) => ({ index })));
    const stagedCount = await staged;
    assert.ok(stagedCount > 1, 'kill while a multi-event transaction is staged');
    const interruptedHead = (await f.connection.db.collection('syncState').findOne({ _id: 'application-data-v2' })).datasets.employees.head;
    assert.ok(interruptedHead + stagedCount <= 400);
    assert.equal(await f.connection.db.collection('syncJournalV2').countDocuments({ dataset: 'employees' }), interruptedHead);
    const exited = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGKILL'); await exited;
    f.start();
    // A killed client cannot abort its transaction; MongoDB may retain its locks until the server's 60s lifetime expires.
    await waitFor(async () => {
        const status = await f.sync.status();
        return status.capture.available && status.datasets.employees.sequence === 400;
    }, 120000);
    // Collection creation may reset the old baseline; either an explicit reset or complete replay is safe.
    try { await old.recover(); assert.equal(old.records.size, 400); }
    catch (error) { assert.equal(error.code, 'RESET_REQUIRED'); assert.equal((await f.client()).records.size, 400); }
    const status = await f.sync.status();
    const entries = await f.connection.db.collection('syncJournalV2').find({ dataset: 'employees', generation: status.datasets.employees.generation }).sort({ sequence: 1 }).toArray();
    assert.deepEqual(entries.map(entry => entry.sequence), Array.from({ length: 400 }, (_, i) => i + 1));
    assert.equal(new Set(entries.map(entry => String(entry.recordId))).size, 400);
});

test('upgraded sockets retain legacy delivery until explicit subscription acknowledgement', { skip: !uri }, async t => {
    const f = await fixture(t), handlers = new Map(), rooms = new Set();
    const socket = { on: (name, callback) => handlers.set(name, callback), join: async name => rooms.add(name) };
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../socket/event/sync.js'), 'utf8'), {
        module, require: name => { assert.equal(name, '../dataSync'); return f.sync; },
    });
    module.exports(socket);
    const call = (event, payload) => new Promise(resolve => handlers.get(event)(payload, resolve));
    const status = await call('sync:status', { negotiate: true, datasets: ['employees'] });
    assert.equal(status.status, 'success'); assert.equal(status.payload.subscriptionRequired, true);
    assert.equal(rooms.size, 0, 'a delayed status reply must not suppress legacy broadcasts');
    assert.equal((await call('sync:subscribe', { datasets: ['user'] })).status, 'error'); assert.equal(rooms.size, 0);
    assert.equal((await call('sync:subscribe', { datasets: ['employees'] })).status, 'success');
    assert.ok(rooms.has('data-sync-v1')); assert.ok(rooms.has('data-sync:employees'));
    rooms.clear(); await call('sync:status', { datasets: ['employees'] });
    assert.ok(rooms.has('data-sync-v1'), 'existing v1 clients retain their activation contract');
});

test('capture receives metadata without full inserted documents and still refreshes client records', { skip: !uri }, async t => {
    const received = [];
    const f = await fixture(t, { serviceFactory: config => {
        const watch = config.connection.db.watch.bind(config.connection.db);
        config.connection.db.watch = (...args) => {
            const stream = watch(...args);
            const next = stream.tryNext.bind(stream);
            stream.tryNext = async () => {
                const change = await next();
                if (change) received.push(change);
                return change;
            };
            return stream;
        };
        return createDataSync(config);
    } });
    const client = await f.client();
    const employee = { name: 'Large profile', portrait: 'x'.repeat(500000) };
    const { insertedId } = await f.connection.db.collection('employee').insertOne(employee);
    await f.catchUp('employees', 1);
    const change = received.find(change => String(change.documentKey?._id) === String(insertedId));
    assert.ok(change);
    assert.equal(change.operationType, 'insert');
    assert.equal(Object.hasOwn(change, 'fullDocument'), false);
    assert.ok(Buffer.byteLength(JSON.stringify(change)) < 2000);
    await client.recover();
    assert.equal(client.records.get(String(insertedId)).name, 'Large profile');
});

test('capture commits bounded batches with contiguous sequences across a large burst', { skip: !uri }, async t => {
    const f = await fixture(t);
    await f.sync.stop();
    const original = f.connection.db.collection.bind(f.connection.db);
    const batches = [];
    f.connection.db.collection = name => {
        const collection = original(name);
        if (name === 'syncJournalV2') {
            const insert = collection.insertMany.bind(collection);
            collection.insertMany = async (entries, options) => { batches.push(entries.length); return insert(entries, options); };
        }
        return collection;
    };
    await original('employee').insertMany(Array.from({ length: 1000 }, (_, index) => ({ name: `Employee ${index}` })));
    f.start();
    await f.catchUp('employees', 1000);
    assert.ok(batches.length < 30, `Expected bounded batches, got ${batches.length}`);
    assert.ok(batches.every(count => count <= 100));
    assert.equal(batches.reduce((sum, count) => sum + count, 0), 1000);
    const entries = await original('syncJournalV2').find({ dataset: 'employees' }).sort({ sequence: 1 }).toArray();
    assert.deepEqual(entries.map(entry => entry.sequence), Array.from({ length: 1000 }, (_, i) => i + 1));
    assert.equal(new Set(entries.map(entry => entry._id)).size, 1000);
});

test('retention cleanup yields to lease renewal under database latency', { skip: !uri }, async t => {
    const errors = [];
    const f = await fixture(t, { leaseMs: 1500, logger: { ...quiet, error: (...args) => errors.push(args) } });
    await f.sync.stop();
    const original = f.connection.db.collection.bind(f.connection.db);
    const pause = () => new Promise(resolve => setTimeout(resolve, 35));
    let cleanupQueries = 0;
    f.connection.db.collection = name => {
        const collection = original(name);
        if (!['syncState', 'syncJournalV2'].includes(name)) return collection;
        for (const method of ['findOne', 'updateOne', 'insertMany']) {
            const operation = collection[method].bind(collection);
            collection[method] = async (...args) => { await pause(); return operation(...args); };
        }
        const find = collection.find.bind(collection);
        collection.find = (...args) => {
            const cursor = find(...args);
            const array = cursor.toArray.bind(cursor);
            cursor.toArray = async () => {
                if (name === 'syncJournalV2' && args[0].dataset && args[0].sequence?.$gt !== undefined) cleanupQueries++;
                await pause(); return array();
            };
            return cursor;
        };
        return collection;
    };
    await original('employee').insertMany(Array.from({ length: 300 }, (_, index) => ({ index })));
    f.start();
    await f.catchUp('employees', 300);
    await waitFor(() => cleanupQueries >= DATASETS.length);
    assert.ok(!errors.some(args => args.includes('LEASE_LOST')), JSON.stringify(errors));
    assert.equal((await f.sync.status()).capture.available, true);
});

test('a recently active consumer still reports stale source capture as unavailable', { skip: !uri }, async t => {
    const f = await fixture(t); await f.sync.stop();
    const original = f.connection.db.watch.bind(f.connection.db);
    let release; const held = new Promise(resolve => { release = resolve; }); let delivered = false, drained = false;
    f.connection.db.watch = (...args) => {
        const stream = original(...args), next = stream.tryNext.bind(stream);
        stream.tryNext = async () => {
            // Finish the source batch before holding the following poll; capture must retain its old source time.
            if (delivered && !drained) { drained = true; return null; }
            if (delivered) await held;
            const change = await next();
            if (change?.operationType === 'insert') { change.wallTime = new Date(Date.now() - 60000); delivered = true; }
            return change;
        };
        return stream;
    };
    try {
        f.start(); await f.connection.db.collection('employee').insertOne({ name: 'Delayed source event' });
        await waitFor(async () => (await f.connection.db.collection('syncState').findOne({ _id: 'application-data-v2' })).datasets.employees.head === 1);
        const status = await f.sync.status();
        assert.equal(status.capture.available, false); assert.ok(status.capture.pollAgeMs < 2000);
        assert.ok(status.capture.lagMs >= 50000);
        await assert.rejects(f.sync.snapshot({ dataset: 'employees', scope: 'all' }), { code: 'UNAVAILABLE' });
    } finally { release(); f.connection.db.watch = original; }
    await waitFor(async () => (await f.sync.status()).capture.available);
});

for (const field of ['businessDate', 'timeZone']) test(`a ${field} change while reading a snapshot rejects the staged scope`, { skip: !uri }, async t => {
    const business = { businessDate: '2026-09-07', timeZone: 'America/New_York' };
    const f = await fixture(t, { getBusinessContext: async () => ({ ...business }) });
    await f.connection.db.collection('inbound').insertOne({ status: 'Pending' }); await f.catchUp('inbound', 1);
    const original = f.connection.db.collection.bind(f.connection.db), collection = original('inbound');
    const find = collection.find.bind(collection);
    collection.find = (...args) => {
        const cursor = find(...args), toArray = cursor.toArray.bind(cursor);
        cursor.toArray = async () => {
            const rows = await toArray(); business[field] = field === 'businessDate' ? '2026-09-08' : 'America/Los_Angeles'; return rows;
        };
        return cursor;
    };
    f.connection.db.collection = name => name === 'inbound' ? collection : original(name);
    try { await assert.rejects(f.sync.snapshot({ dataset: 'inbound', scope: '2026-09-07' }), { code: 'RESET_REQUIRED' }); }
    finally { f.connection.db.collection = original; }
});

test('snapshot and delta byte limits do not repeatedly serialize the growing page', { skip: !uri }, async t => {
    const filename = path.join(__dirname, '../utils/dataSync.js');
    const module = { exports: {} };
    let pageSerializations = 0;
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module,
        require: require('node:module').createRequire(filename), Date, Buffer, setTimeout, clearTimeout,
        JSON: { ...JSON, stringify: value => {
            if (value?.upserts) pageSerializations++;
            return JSON.stringify(value);
        } },
    });
    const f = await fixture(t, { serviceFactory: module.exports.createDataSync });
    await f.connection.db.collection('employee').insertOne({ name: 'Anchor' });
    await f.catchUp('employees', 1);
    const cursor = await f.current('employees');
    await f.connection.db.collection('employee').insertMany(Array.from({ length: 500 }, (_, index) => ({ name: `${index}: ${'x'.repeat(2000)}` })));
    await f.catchUp('employees', 501);
    for (const read of [() => f.sync.snapshot({ dataset: 'employees', scope: 'all' }),
        () => f.sync.pull({ dataset: 'employees', scope: 'all', cursor })]) {
        pageSerializations = 0;
        const page = await read();
        assert.equal(page.upserts.length, 500);
        assert.ok(pageSerializations <= 3, `Serialized the growing page ${pageSerializations} times`);
        assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 4 * 1024 * 1024);
    }
});
