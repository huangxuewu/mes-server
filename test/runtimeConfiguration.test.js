const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const runtime = require('../utils/runtimeConfig');
const { quotaSettings, createGmailQuota } = require('../utils/gmailQuota');
const { createAppointmentRefreshCoordinator } = require('../utils/appointmentRefresh');

const fixture = () => {
    const records = new Map();
    let administrator = true;
    const db = { config: {
        find: query => ({ maxTimeMS: () => ({ lean: async () => [...records.values()].filter(record => query.key.$in.includes(record.key)
            && record.scope === query.scope && record.status === query.status && record.effective.from <= query['effective.from'].$lte
            && (!record.effective.to || record.effective.to >= query.$or[1]['effective.to'].$gte)) }) }),
        findOneAndUpdate: async ({ key, scope }, update, options) => {
            assert.equal(scope, 'Global');
            assert.equal(options.upsert, true);
            assert.equal(options.runValidators, true);
            const record = { ...(records.get(key) || { key, ...update.$setOnInsert }), ...update.$set };
            records.set(key, record);
            return record;
        },
    } };
    const context = { module: { exports: {} }, Date, require: name => {
        if (name === '../../models') return db;
        if (name.endsWith('runtimeConfig')) return runtime;
        if (name === '../session') return { getActiveSessionUser: async () => ({}), hasPermission: () => administrator };
        if (name.endsWith('stationScreenshots')) return { getStationScreenshots: () => ({}) };
        if (name.endsWith('stationLive')) return { getStationLive: () => ({}) };
        if (name.endsWith('stationRoster')) return { getStationRoster: () => ({}) };
        return {};
    } };
    vm.runInNewContext(fs.readFileSync(require.resolve('../socket/event/config'), 'utf8'), context);
    const handlers = {};
    context.module.exports({ on: (event, handler) => { handlers[event] = handler; } }, {});
    return { db, records, handlers, role: value => { administrator = value; },
        save: (key, value) => new Promise(resolve => handlers['config:update']({ key, value }, resolve)) };
};

test('all runtime settings can be created, replaced and read without restart', async () => {
    const f = fixture();
    assert.deepEqual(await runtime.readRuntimeConfig({ db: f.db }), runtime.defaults);
    for (const [key, value] of Object.entries(runtime.defaults)) {
        const result = await f.save(key, value);
        assert.equal(result.status, 'success');
        assert.equal(f.records.get(key)._id, `cfg.${key}`);
    }
    await f.save('integration.gmail.userQuotaLimit', 3000);
    assert.equal(quotaSettings(await runtime.readRuntimeConfig({ db: f.db })).userBudget, 2400);
    await f.save('integration.gmail.userQuotaLimit', 6000);
    assert.equal(quotaSettings(await runtime.readRuntimeConfig({ db: f.db })).userBudget, 4800);
    await f.save('integration.gmail.syncPaused', true);
    assert.equal((await runtime.readRuntimeConfig({ db: f.db }))['integration.gmail.syncPaused'], true);
    await f.save('integration.gmail.incrementalSync', false);
    assert.equal((await runtime.readRuntimeConfig({ db: f.db }))['integration.gmail.incrementalSync'], false);
});

test('new peer connections use saved ICE settings and sharing never receives TURN credentials', async () => {
    const f = fixture();
    for (const [key, value] of Object.entries({ 'integration.sharing.stunUrls': 'stun:mes.example:3478',
        'integration.stationLive.turnUrls': 'turns:relay.example:5349?transport=tcp',
        'integration.stationLive.turnUsername': 'user', 'integration.stationLive.turnCredential': 'secret' })) await f.save(key, value);
    const sharing = await runtime.getIceServers({ db: f.db });
    assert.deepEqual(sharing, [{ urls: ['stun:mes.example:3478'] }]);
    assert.equal((await runtime.getIceServers({ db: f.db, relay: true }))[1].credential, 'secret');
    await f.save('integration.sharing.stunUrls', '');
    assert.deepEqual(await runtime.getIceServers({ db: f.db }), []);
    await f.save('integration.stationLive.turnCredential', '');
    assert.deepEqual(await runtime.getIceServers({ db: f.db, relay: true }), []);
});

test('invalid protocols, numeric limits, types and project numbers are rejected before persistence', async () => {
    const f = fixture();
    for (const [key, value] of [['integration.sharing.stunUrls', 'https://example.com'], ['integration.sharing.stunUrls', 'stun:host,'],
        ['integration.stationLive.turnUrls', 'turn:host?transport=unknown'], ['integration.gmail.userQuotaLimit', 124],
        ['integration.gmail.projectQuotaLimit', 1200001], ['integration.gmail.userQuotaLimit', NaN],
        ['integration.gmail.userQuotaLimit', 500.5], ['integration.gmail.syncPaused', 'true'],
        ['integration.gmail.quotaProject', 'project-name'], ['integration.stationLive.turnCredential', 'a\nb']]) {
        assert.equal((await f.save(key, value)).status, 'error');
    }
    assert.equal(f.records.size, 0);
});

test('only active effective global values override defaults; database failures propagate', async () => {
    const f = fixture(), key = 'integration.gmail.syncPaused';
    await f.save(key, true);
    const record = f.records.get(key);
    for (const change of [{ status: 'Inactive' }, { scope: 'User' }, { effective: { from: new Date(Date.now() + 60000) } },
        { effective: { from: new Date(0), to: new Date(1) } }]) {
        f.records.set(key, { ...record, ...change });
        assert.equal((await runtime.readRuntimeConfig({ db: f.db }))[key], false);
    }
    f.db.config.find = () => { throw new Error('Database unavailable'); };
    await assert.rejects(runtime.readRuntimeConfig({ db: f.db }), /Database unavailable/);
});

test('relay credentials require configuration access and are excluded from unauthorized reads', async () => {
    const f = fixture(), key = 'integration.stationLive.turnCredential';
    f.role(false);
    assert.equal((await f.save(key, 'secret')).message, 'accessDenied');
    let filter;
    f.db.config.find = query => { filter = query; return []; };
    await new Promise(resolve => f.handlers['config:fetch']({}, resolve));
    assert.equal(filter.$and[1].key.$ne, key);
    f.role(true);
    assert.equal((await f.save(key, 'secret')).status, 'success');
});

test('Gmail dispatch reads pause and quota changes through the connected database', async () => {
    let paused = true, limit = 3000, reserved, leases = 0;
    const collections = {
        config: { find: () => ({ toArray: async () => [
            { key: 'integration.gmail.syncPaused', value: paused }, { key: 'integration.gmail.userQuotaLimit', value: limit },
        ] }) },
        gmailSync: { updateOne: async () => ({}), findOneAndUpdate: async () => { leases++; return null; } },
        gmailQuota: { updateOne: async (_query, update) => { if (update.$set.userBudget) reserved = update.$set; return { modifiedCount: 1 }; },
            aggregate: () => ({ next: async () => ({ version: 0, entries: [], ...reserved, serverNow: new Date() }) }) },
    };
    const connection = { asPromise: async () => {}, db: { collection: name => collections[name] } };
    const coordinator = createAppointmentRefreshCoordinator({ connection, executeStep: () => assert.fail('No work queued') });
    await coordinator.tick(); assert.equal(leases, 0);
    paused = false; await coordinator.tick(); assert.equal(leases, 1);
    const gate = createGmailQuota({ connection });
    await gate.reserve({ project: '123', mailbox: 'test', method: 'getProfile' });
    assert.equal(reserved.userBudget, 2400);
    limit = 6000;
    await gate.reserve({ project: '123', mailbox: 'test', method: 'getProfile' });
    assert.equal(reserved.userBudget, 4800);
});
