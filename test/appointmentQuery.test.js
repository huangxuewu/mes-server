const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { randomUUID } = require('node:crypto');
const mongoose = require('mongoose');

const uri = process.env.GMAIL_TEST_URI;
const fixture = async t => {
    assert.match(uri, /^mongodb:\/\/(127\.0\.0\.1|localhost):\d+\/gmail_test_[a-z\d_]+(?:\?|$)/i);
    const connection = await mongoose.createConnection(uri, { dbName: `gmail_test_${randomUUID().replaceAll('-', '')}` }).asPromise();
    t.after(() => connection.close());
    const threads = connection.db.collection('emailThread');
    const queries = [];
    let prepareThreads;
    const load = (relative, overrides) => {
        const filename = path.join(__dirname, '..', relative);
        const localRequire = createRequire(filename);
        const module = { exports: {} };
        vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
            module, exports: module.exports, console,
            require: name => Object.hasOwn(overrides, name) ? overrides[name] : localRequire(name),
        }, { filename });
        return module.exports;
    };
    const outbound = load('models/outbound.js', {
        '../socket/io': { io: {} },
        '../config/database': { model: () => ({ hooks: { pre() {} },
            aggregate: pipeline => connection.db.collection('outbound').aggregate(pipeline).toArray(),
            createIndexes() {}, watch: () => ({ on() {} }),
        }) },
    });
    const register = load('socket/event/appointment.js', {
        '../../models': { config: { db: connection }, outbound,
            emailThread: { find: filter => {
                queries.push(filter);
                const cursor = threads.find(filter);
                const query = { lean: () => cursor.toArray(), sort: value => { cursor.sort(value); return query; } };
                return query;
            } },
        },
        '../../utils/gmail': { getClient: async () => ({ context: { mailbox: 'mailbox-a' } }) },
        '../../utils/deepseek': {},
        '../../utils/appointmentAi': {},
        '../../utils/appointmentRefresh': { createAppointmentRefreshCoordinator: () => ({ start() {} }) },
        '../../utils/gmailSync': { createGmailSyncStep: options => { prepareThreads = options.prepareThreads; } },
        '../io': { io: {} },
    });
    const handlers = {};
    register({ on: (event, handler) => { handlers[event] = handler; } }, {});
    return { connection, threads, outbound, queries, prepareThreads,
        query: () => new Promise(resolve => handlers['appointments:query']({}, resolve)) };
};

test('appointment queries return active load 77834596 and shared threads without downloading inactive mail', { skip: !uri }, async t => {
    const f = await fixture(t);
    await f.connection.db.collection('outbound').insertOne({ loads: [
        { loadNumber: '77834596', status: 'Carrier Accepted, Awaiting Pickup', proNumber: '4038376' },
        { loadNumber: 'past-pickup', status: 'Past Pickup' },
        { loadNumber: 'completed', status: 'Completed' },
    ] });
    await f.threads.insertMany([
        { _id: 'target', mailbox: 'mailbox-a', threadId: 'target', loadNumber: '77834596',
            messages: [{ messageId: 'one', body: 'Pickup 77834596' }, { messageId: 'two' }, { messageId: 'three' }] },
        { _id: 'shared', mailbox: 'mailbox-a', threadId: 'shared', loadNumber: 'completed',
            loadAssociations: [{ loadNumber: '77834596' }], messages: [] },
        { _id: 'legacy', threadId: 'legacy', loadNumber: 'past-pickup', messages: [] },
        { _id: 'unrelated', mailbox: 'mailbox-a', threadId: 'unrelated', loadNumber: 'completed', messages: [{ body: 'x'.repeat(1000000) }] },
        { _id: 'other-mailbox', mailbox: 'mailbox-b', threadId: 'other', loadNumber: '77834596', messages: [] },
    ]);
    const active = await f.outbound.getActiveLoads();
    assert.deepEqual(active.map(load => load.loadNumber).sort(), ['77834596', 'past-pickup']);
    const result = await f.query();
    assert.equal(result.status, 'success');
    assert.deepEqual(result.payload.map(thread => thread._id).sort(), ['legacy', 'shared', 'target']);
    assert.equal(result.payload.find(thread => thread._id === 'target').messages.length, 3);
    assert.ok(JSON.stringify(result.payload).length < 5000);
    // Verify the database query itself excludes the large inactive document.
    assert.equal(await f.threads.countDocuments(f.queries[0]), 3);
});

test('no active outgoing loads returns no threads rather than the whole mailbox', { skip: !uri }, async t => {
    const f = await fixture(t);
    await f.connection.db.collection('outbound').insertOne({ loads: [{ loadNumber: 'completed', status: 'Completed' }] });
    await f.threads.insertOne({ mailbox: 'mailbox-a', threadId: 'old', loadNumber: 'completed', messages: [] });
    const result = await f.query();
    assert.equal(result.status, 'success');
    assert.equal(result.payload.length, 0);
    assert.equal(await f.threads.countDocuments(f.queries[0]), 0);
});

test('finishing a sync hydrates only active load associations', { skip: !uri }, async t => {
    const f = await fixture(t);
    await f.threads.insertMany([
        { mailbox: 'mailbox-a', threadId: 'active', loadNumber: '77834596', messages: [] },
        { mailbox: 'mailbox-a', threadId: 'inactive', loadNumber: 'completed', messages: [{ body: 'x'.repeat(1000000) }] },
    ]);
    await f.prepareThreads([], 'test@example.com', [{ loadNumber: '77834596' }], 'mailbox-a');
    assert.equal(await f.threads.countDocuments(f.queries[0]), 1);
});
