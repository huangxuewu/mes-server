const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { createGmailQuota, GmailDeferred } = require('../utils/gmailQuota');
const { createAppointmentRefreshCoordinator } = require('../utils/appointmentRefresh');
const { prepareGmailMailbox } = require('../utils/gmailMailbox');

const uri = process.env.GMAIL_TEST_URI;
const quiet = { info() {}, warn() {}, error() {} };
const fixture = async t => {
    assert.match(uri, /^mongodb:\/\/(127\.0\.0\.1|localhost):\d+\/gmail_test_[a-z\d_]+(?:\?|$)/i);
    const dbName = `gmail_test_${randomUUID().replaceAll('-', '')}`;
    const connection = await mongoose.createConnection(uri, { dbName }).asPromise();
    const other = await mongoose.createConnection(uri, { dbName }).asPromise();
    await connection.db.createCollection('evidence');
    t.after(async () => { await other.close(); await connection.close(); });
    return { connection, other };
};

test('two workers atomically share quota and a restart retains recent cost', { skip: !uri }, async t => {
    const { connection, other } = await fixture(t);
    const first = createGmailQuota({ connection, logger: quiet });
    const second = createGmailQuota({ connection: other, logger: quiet });
    const context = { project: 'test', mailbox: 'mailbox', method: 'threads.get' };
    const results = await Promise.allSettled(Array.from({ length: 20 }, (_, index) => (index % 2 ? first : second).reserve(context)));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.ok(results.filter(result => result.status === 'rejected').every(result => result.reason instanceof GmailDeferred));
    const state = await connection.db.collection('gmailQuota').findOne({ _id: 'test' });
    assert.equal(state.entries.length, 1);
    const restarted = createGmailQuota({ connection, logger: quiet });
    await assert.rejects(restarted.reserve(context), GmailDeferred);
});

test('all failed attempts retain cost, disable transport retries and share cooldown', { skip: !uri }, async t => {
    const { connection, other } = await fixture(t);
    const gate = createGmailQuota({ connection, logger: quiet });
    const context = { project: 'test', mailbox: 'mailbox' };
    let calls = 0;
    await assert.rejects(gate.run(context, 'threads.get', async options => {
        calls++;
        assert.equal(options.retry, false);
        assert.equal(options.retryConfig.retry, 0);
        const error = new Error('Quota exceeded: Units per minute per user');
        error.response = { status: 429, headers: { 'retry-after': '120' } };
        throw error;
    }), /Quota exceeded/);
    const otherGate = createGmailQuota({ connection: other, logger: quiet });
    await assert.rejects(otherGate.run(context, 'messages.send', () => { calls++; }), GmailDeferred);
    assert.equal(calls, 1);
    const state = await connection.db.collection('gmailQuota').findOne({ _id: 'test' });
    assert.equal(state.entries[0].cost, 40);
    assert.ok(+state.mailboxBlocks.mailbox > Date.now() + 100000);
    assert.ok(+state.entries[0].retainUntil > Date.now() + 59000);
});

test('coordination failure never dispatches a Gmail call', async () => {
    const gate = createGmailQuota({ connection: { asPromise: async () => { throw new Error('offline'); } }, logger: quiet });
    let calls = 0;
    await assert.rejects(gate.run({ project: 'test' }, 'getProfile', () => { calls++; }), /offline/);
    assert.equal(calls, 0);
});

test('refresh acknowledges promptly, coalesces clients and commits work once across workers', { skip: !uri }, async t => {
    const { connection, other } = await fixture(t);
    let release;
    let entered;
    const started = new Promise(resolve => { entered = resolve; });
    const pending = new Promise(resolve => { release = resolve; });
    let executions = 0;
    const executeStep = async () => {
        executions++;
        entered();
        await pending;
        return { complete: true, patch: { newMessages: 1 }, apply: session =>
            connection.db.collection('evidence').insertOne({ _id: 'once' }, { session }) };
    };
    const a = createAppointmentRefreshCoordinator({ connection, executeStep, logger: quiet });
    const b = createAppointmentRefreshCoordinator({ connection: other, executeStep, logger: quiet });
    t.after(async () => { release(); await a.stop(); await b.stop(); });
    const response = await a.request();
    assert.equal(response.lastSuccessfulSyncAt, null);
    assert.ok(['queued', 'syncing'].includes(response.syncStatus));
    await started;
    await Promise.all(Array.from({ length: 12 }, () => b.request({ force: true })));
    await b.tick();
    assert.equal(executions, 1);
    release();
    await a.stop();
    const status = await a.status();
    assert.equal(status.syncStatus, 'complete');
    assert.ok(status.lastSuccessfulSyncAt);
    assert.equal(await connection.db.collection('evidence').countDocuments(), 1);
});

test('expired lease resumes checkpoint and stale owner cannot commit', { skip: !uri }, async t => {
    const { connection, other } = await fixture(t);
    let release;
    let entered;
    const started = new Promise(resolve => { entered = resolve; });
    const pending = new Promise(resolve => { release = resolve; });
    const a = createAppointmentRefreshCoordinator({ connection, logger: quiet, executeStep: async () => {
        entered(); await pending;
        return { complete: true, apply: session => connection.db.collection('evidence').insertOne({ _id: 'stale' }, { session }) };
    } });
    const b = createAppointmentRefreshCoordinator({ connection: other, logger: quiet, executeStep: async state => {
        assert.equal(state.progress.page, 3);
        return { complete: true, apply: session => other.db.collection('evidence').insertOne({ _id: 'new' }, { session }) };
    } });
    t.after(async () => { release(); await a.stop(); await b.stop(); });
    await a.request(); await started;
    await connection.db.collection('gmailSync').updateOne({ _id: 'appointments' },
        { $set: { leaseUntil: new Date(0), progress: { page: 3 } } });
    await b.tick();
    release(); await a.stop();
    assert.equal(await connection.db.collection('evidence').countDocuments({ _id: 'stale' }), 0);
    assert.equal(await connection.db.collection('evidence').countDocuments({ _id: 'new' }), 1);
});

test('quota deferral preserves progress and timestamp, and force cannot bypass it', { skip: !uri }, async t => {
    const { connection } = await fixture(t);
    let calls = 0;
    const coordinator = createAppointmentRefreshCoordinator({ connection, logger: quiet,
        executeStep: async () => { calls++; throw new GmailDeferred(Date.now() + 120000); } });
    t.after(() => coordinator.stop());
    await coordinator.request();
    await coordinator.stop();
    const status = await coordinator.request({ force: true });
    assert.equal(status.syncStatus, 'waiting');
    assert.equal(status.lastSuccessfulSyncAt, null);
    assert.ok(+status.nextRetryAt > Date.now() + 100000);
    assert.equal(calls, 1);
});

const gmailFixture = connection => {
    let sends = 0;
    let uncertain = false;
    let visible = false;
    let failRead = false;
    const calls = [];
    const response = (method, action) => async (params, options) => {
        assert.equal(options.retry, false);
        assert.equal(options.retryConfig.retry, 0);
        calls.push(method);
        return { data: await action(params) };
    };
    const filename = path.join(__dirname, '../utils/gmail.js');
    const localRequire = createRequire(filename);
    const config = { db: connection, find: () => ({ lean: async () => [
        { key: 'integration.gmail.clientId', value: '123-test.apps.googleusercontent.com' },
        { key: 'integration.gmail.clientSecret', value: 'test-secret' },
        { key: 'integration.gmail.refreshToken', value: 'test-refresh' },
        { key: 'integration.gmail.redirectUri', value: 'http://localhost' },
    ] }) };
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, exports: module.exports, Buffer, process,
        require: name => {
            if (name === '../models') return { config };
            if (name === './gmailQuota') return { GmailDeferred, createGmailQuota: () => ({ run: async (_context, _method, execute) =>
                execute({ retry: false, retryConfig: { retry: 0 }, timeout: 20000 }) }) };
            if (name !== 'googleapis/build/src/apis/gmail') return localRequire(name);
            return { auth: { OAuth2: class {
                setCredentials() {}
                async getAccessToken() { return { token: 'test-token' }; }
            } }, gmail: options => {
                assert.equal(options.auth, undefined);
                return { users: {
                    getProfile: response('getProfile', () => ({ emailAddress: 'test@example.com', historyId: '1' })),
                    messages: {
                        send: response('messages.send', () => {
                            sends++;
                            if (uncertain) throw new Error('network timeout');
                            return { id: 'sent-1', threadId: 'thread-1' };
                        }),
                        list: response('messages.list', () => ({ messages: visible ? [{ id: 'sent-1' }] : [] })),
                        get: response('messages.get', () => {
                            if (failRead) throw new Error('temporary read failure');
                            return { id: 'sent-1', threadId: 'thread-1', internalDate: '1',
                                payload: { headers: [{ name: 'Subject', value: 'Load' }], body: {} } };
                        }),
                    },
                } };
            } };
        },
    }, { filename });
    return { gmail: module.exports, sends: () => sends, calls,
        uncertain: value => { uncertain = value; }, visible: value => { visible = value; }, failRead: value => { failRead = value; } };
};

test('duplicate send operations return their persisted result without another send', { skip: !uri }, async t => {
    const { connection } = await fixture(t);
    const f = gmailFixture(connection);
    const draft = { operationId: randomUUID(), to: 'recipient@example.com', subject: 'Load', body: 'Test' };
    const first = await f.gmail.sendEmail(draft);
    const second = await f.gmail.sendEmail({ ...draft, subject: 'Re: Load', threadId: 'thread-1', inReplyTo: 'updated' });
    assert.equal(first.messageId, second.messageId);
    assert.equal(f.sends(), 1);
    assert.deepEqual(f.calls, ['getProfile', 'messages.send']);
    await assert.rejects(f.gmail.sendEmail({ ...draft, body: 'Different content' }), /different content/);
});

test('ambiguous delivery and failed reconciliation reads never repeat a send', { skip: !uri }, async t => {
    const { connection } = await fixture(t);
    const f = gmailFixture(connection);
    const draft = { operationId: randomUUID(), to: 'recipient@example.com', subject: 'Load', body: 'Test' };
    f.uncertain(true);
    await assert.rejects(f.gmail.sendEmail(draft), error => error.code === 'GMAIL_SEND_UNCERTAIN');
    await assert.rejects(f.gmail.sendEmail(draft), /unconfirmed/);
    f.visible(true); f.failRead(true);
    await assert.rejects(f.gmail.sendEmail(draft), /read failure/);
    f.failRead(false);
    assert.equal((await f.gmail.sendEmail(draft)).messageId, 'sent-1');
    assert.equal(f.sends(), 1);
});

test('mailbox upgrade preserves legacy appointments and scopes uniqueness to each mailbox', { skip: !uri }, async t => {
    const { connection } = await fixture(t);
    const threads = connection.db.collection('emailThread');
    await threads.createIndex({ threadId: 1 }, { unique: true });
    await threads.insertOne({ threadId: 'legacy', messages: [{ messageId: 'message' }] });
    await prepareGmailMailbox(connection, 'mailbox-a');
    assert.equal((await threads.findOne({ threadId: 'legacy' })).mailbox, 'mailbox-a');
    await threads.insertOne({ mailbox: 'mailbox-b', threadId: 'legacy', messages: [] });
    await assert.rejects(threads.insertOne({ mailbox: 'mailbox-a', threadId: 'legacy' }), error => error.code === 11000);
    assert.equal((await threads.findOne({ mailbox: 'mailbox-a' })).messages[0].messageId, 'message');
});

test('overlapping legacy threads migrate atomically across workers without losing messages or appointments', { skip: !uri }, async t => {
    const { connection, other } = await fixture(t);
    const threads = connection.db.collection('emailThread');
    await threads.createIndex({ mailbox: 1, threadId: 1 }, { unique: true, name: 'mailbox_thread_unique' });
    await threads.insertMany([
        { _id: 'legacy', threadId: 'overlap', subject: 'Original subject', status: 'New', messages: [
            { messageId: 'shared', body: 'original', loadNumbers: ['old-load'] },
            { messageId: 'legacy-only', body: 'preserved' },
        ], loadAssociations: [{ loadNumber: 'shared-load', status: 'New' }, { loadNumber: 'old-load', status: 'Scheduled' }] },
        { _id: 'current', mailbox: 'mailbox-a', threadId: 'overlap', status: 'Confirmed', messages: [
            { messageId: 'shared', body: 'current', loadNumbers: ['new-load'] },
            { messageId: 'current-only', body: 'also preserved' },
        ], loadAssociations: [{ loadNumber: 'shared-load', status: 'Confirmed' }, { loadNumber: 'new-load', status: 'New' }] },
        { _id: 'other-mailbox', mailbox: 'mailbox-b', threadId: 'overlap', messages: [] },
    ]);
    // This is the old migration's failure, before its checkpoint can advance.
    await assert.rejects(threads.updateMany({ mailbox: { $exists: false } }, { $set: { mailbox: 'mailbox-a' } }),
        error => error.code === 11000);
    await Promise.all([prepareGmailMailbox(connection, 'mailbox-a'), prepareGmailMailbox(other, 'mailbox-a')]);
    const current = await threads.findOne({ _id: 'current' });
    assert.equal(await threads.countDocuments({ mailbox: { $exists: false } }), 0);
    assert.equal(await threads.countDocuments({ mailbox: 'mailbox-a' }), 1);
    assert.equal(current.subject, 'Original subject');
    assert.equal(current.status, 'Confirmed');
    assert.deepEqual(current.messages.map(message => message.messageId), ['shared', 'legacy-only', 'current-only']);
    assert.equal(current.messages[0].body, 'current');
    assert.deepEqual(current.messages[0].loadNumbers, ['old-load', 'new-load']);
    assert.deepEqual(current.loadAssociations, [{ loadNumber: 'shared-load', status: 'Confirmed' },
        { loadNumber: 'old-load', status: 'Scheduled' }, { loadNumber: 'new-load', status: 'New' }]);
    assert.deepEqual((await threads.findOne({ _id: 'other-mailbox' })).messages, []);
    await prepareGmailMailbox(connection, 'mailbox-a');
    assert.deepEqual(await threads.findOne({ _id: 'current' }), current);
});

test('failed legacy merge rolls back both records and retries successfully from the saved job', { skip: !uri }, async t => {
    const { connection } = await fixture(t);
    const threads = connection.db.collection('emailThread');
    const originals = [
        { _id: 'legacy', threadId: 'overlap', messages: [{ messageId: 'legacy-only' }] },
        { _id: 'current', mailbox: 'mailbox-a', threadId: 'overlap', messages: [{ messageId: 'current-only' }] },
    ];
    await threads.insertMany(originals);
    const deleteOne = threads.deleteOne.bind(threads);
    threads.deleteOne = async () => { throw new Error('interrupted merge'); };
    const migrationConnection = { db: { collection: () => threads }, startSession: () => connection.startSession() };
    await assert.rejects(prepareGmailMailbox(migrationConnection, 'mailbox-a'), /interrupted merge/);
    for (const original of originals) assert.deepEqual(await threads.findOne({ _id: original._id }), original);
    threads.deleteOne = deleteOne;
    const coordinator = createAppointmentRefreshCoordinator({ connection, logger: quiet, executeStep: async () => {
        await prepareGmailMailbox(migrationConnection, 'mailbox-a');
        return { complete: true };
    } });
    t.after(() => coordinator.stop());
    await coordinator.status();
    await connection.db.collection('gmailSync').updateOne({ _id: 'appointments' }, { $set: { syncStatus: 'waiting', attempts: 101 } });
    await coordinator.tick();
    const state = await connection.db.collection('gmailSync').findOne({ _id: 'appointments' });
    assert.equal(state.syncStatus, 'complete');
    assert.equal(state.attempts, 0);
    assert.ok(state.lastSuccessfulSyncAt);
    assert.equal(await threads.countDocuments(), 1);
    assert.deepEqual((await threads.findOne({ _id: 'current' })).messages.map(message => message.messageId), ['legacy-only', 'current-only']);
});

test('duplicate-key failure exits automatic retries and logs the index without private key values', { skip: !uri }, async t => {
    const { connection } = await fixture(t);
    const warnings = [];
    let calls = 0;
    const coordinator = createAppointmentRefreshCoordinator({ connection,
        logger: { ...quiet, warn: (...args) => warnings.push(args) }, executeStep: async () => {
            calls++;
            throw Object.assign(new Error('E11000 duplicate key error collection: test.emailThread index: mailbox_thread_unique dup key: { mailbox: "private" }'),
                { code: 11000, keyPattern: { mailbox: 1, threadId: 1 }, keyValue: { mailbox: 'private' } });
        } });
    t.after(() => coordinator.stop());
    await coordinator.status();
    const lastSuccessfulSyncAt = new Date('2026-09-08T17:39:38.447Z');
    const progress = { pending: ['thread-to-resume'] };
    await connection.db.collection('gmailSync').updateOne({ _id: 'appointments' }, { $set: {
        syncStatus: 'waiting', attempts: 100, progress, lastSuccessfulSyncAt,
    } });
    await coordinator.tick();
    const state = await connection.db.collection('gmailSync').findOne({ _id: 'appointments' });
    assert.equal(state.attempts, 101);
    assert.equal(state.syncStatus, 'failed');
    assert.deepEqual(state.progress, progress);
    assert.deepEqual(state.lastSuccessfulSyncAt, lastSuccessfulSyncAt);
    await connection.db.collection('gmailSync').updateOne({ _id: 'appointments' }, { $set: { nextRetryAt: new Date(0) } });
    await coordinator.tick();
    assert.equal(calls, 1);
    assert.deepEqual(warnings, [['gmail.sync.failed', { reason: 'duplicateKey', code: 11000, attempts: 101,
        collection: 'test.emailThread', index: 'mailbox_thread_unique', keyFields: ['mailbox', 'threadId'] }]]);
});

test('retry exhaustion defers the saved step instead of starting an unbounded retry loop', { skip: !uri }, async t => {
    const { connection } = await fixture(t);
    const coordinator = createAppointmentRefreshCoordinator({ connection, logger: quiet, executeStep: async () => {
        const error = new Error('temporary Gmail failure'); error.response = { status: 503 }; throw error;
    } });
    t.after(() => coordinator.stop());
    await coordinator.status();
    await connection.db.collection('gmailSync').updateOne({ _id: 'appointments' }, { $set: {
        syncStatus: 'queued', attempts: 5, progress: { pending: ['thread-to-resume'] },
    } });
    await coordinator.tick();
    const state = await connection.db.collection('gmailSync').findOne({ _id: 'appointments' });
    assert.equal(state.attempts, 6);
    assert.equal(state.syncStatus, 'waiting');
    assert.ok(+state.nextRetryAt >= Date.now() + 299000);
    assert.deepEqual(state.progress.pending, ['thread-to-resume']);
});
