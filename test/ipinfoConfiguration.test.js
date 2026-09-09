const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRegionLocator } = require('../utils/sharingLocation');
const { createSharing } = require('../socket/sharing');

const fixture = (env = {}) => {
    const records = new Map(), requests = [], queries = [];
    let response = { country_code: 'US', country: 'United States' };
    let time = Date.now() + 1000, fail = false, databaseFailed = false;
    const db = { config: {
        find: query => {
            queries.push(query);
            return { maxTimeMS: () => ({ lean: async () => {
                if (databaseFailed) throw new Error('Database unavailable');
                return [...records.values()].filter(record => query.key.$in.includes(record.key) && record.scope === query.scope
                    && record.status === query.status && record.effective.from <= query['effective.from'].$lte
                    && (!record.effective.to || record.effective.to >= query.$or[1]['effective.to'].$gte));
            } }) };
        },
        findOneAndUpdate: async ({ key }, update, options) => {
            assert.equal(options.upsert, true);
            assert.equal(options.runValidators, true);
            const record = { ...(records.get(key) || { key, ...update.$setOnInsert }), ...update.$set };
            records.set(key, record);
            return record;
        },
    } };
    const context = { module: { exports: {} }, Date, console: { log: () => assert.fail('Configuration values must not be logged') }, require: name => {
        if (name === '../../models') return db;
        if (name.endsWith('stationScreenshots')) return { getStationScreenshots: () => ({}) };
        if (name.endsWith('stationLive')) return { getStationLive: () => ({}) };
        if (name.endsWith('stationRoster')) return { getStationRoster: () => ({}) };
        return {};
    } };
    vm.runInNewContext(fs.readFileSync(require.resolve('../socket/event/config'), 'utf8'), context);
    const handlers = {};
    context.module.exports({ on: (event, handler) => { handlers[event] = handler; } }, {});
    const save = (field, value) => new Promise(resolve => handlers['config:update']({ key: `integration.ipinfo.${field}`, value }, resolve));
    const http = { get: async (url, options) => {
        requests.push({ url, options });
        if (fail) throw new Error('Lookup unavailable');
        return { data: response };
    } };
    const locate = createRegionLocator({ db, http, env, now: () => time });
    const socket = { id: 'peer', connected: true, handshake: { address: '8.8.8.8', headers: {} }, data: { sessionGeneration: 1, expiresAt: time + 1e9 }, emit() {} };
    return { save, locate, socket, records, requests, queries, now: () => time, advance: ms => { time += ms; },
        response: value => { response = value; }, fail: value => { fail = value; }, databaseFail: value => { databaseFailed = value; } };
};

test('integration saves create missing database records and the server uses saved credentials', async () => {
    const f = fixture({ SHARING_IPINFO_TOKEN: 'env-key' });
    assert.equal((await f.save('token', ' saved-key ')).status, 'success');
    const account = f.records.get('integration.ipinfo.token');
    assert.equal(account._id, 'cfg.integration.ipinfo.token');
    assert.equal(account.scope, 'Global');
    assert.equal(account.status, 'Active');
    assert.deepEqual(await f.locate(f.socket), { key: 'US', label: 'United States' });
    assert.equal(f.requests[0].options.headers.Authorization, 'Bearer saved-key');
    assert.equal(f.requests[0].url, 'https://api.ipinfo.io/lite/8.8.8.8');
    assert.equal(f.requests[0].options.timeout, 4000);
    await f.save('token', 'replacement');
    assert.equal(f.records.size, 1, 'editing updates the existing records');
    await f.locate(f.socket);
    assert.equal(f.requests[1].options.headers.Authorization, 'Bearer replacement', 'updated credentials invalidate the old location cache');
});

test('settings reject whitespace and non-text tokens, and support clearing credentials', async () => {
    const f = fixture();
    assert.equal((await f.save('token', 'bad token')).status, 'error');
    assert.equal((await f.save('token', { secret: 'bad' })).status, 'error');
    assert.equal((await f.save('token', 'x'.repeat(257))).status, 'error');
    assert.equal(f.records.size, 0);
    await f.save('token', 'key');
    await f.locate(f.socket);
    assert.equal((await f.save('token', '')).status, 'success');
    assert.equal(await f.locate(f.socket), null);
    assert.equal(f.requests.length, 1);
});

test('environment token is used when the saved token is empty', async () => {
    const f = fixture({ SHARING_IPINFO_TOKEN: 'env-key' });
    await f.locate(f.socket);
    assert.equal(f.requests[0].options.headers.Authorization, 'Bearer env-key');
    await f.save('token', 'saved');
    await f.locate(f.socket);
    assert.equal(f.requests[1].options.headers.Authorization, 'Bearer saved');
    await f.save('token', '');
    await f.locate(f.socket);
    assert.equal(f.requests[2].options.headers.Authorization, 'Bearer env-key');
});

test('only active, effective global configuration is used', async () => {
    const f = fixture();
    await f.save('token', 'key');
    const key = f.records.get('integration.ipinfo.token');
    for (const change of [{ status: 'Inactive' }, { scope: 'User' }, { effective: { from: new Date(f.now() + 60000) } }, { effective: { from: new Date(0), to: new Date(1) } }]) {
        f.records.set(key.key, { ...key, ...change });
        assert.equal(await f.locate(f.socket), null);
    }
    assert.equal(f.requests.length, 0);
});

test('lookup failures retry after five minutes and changed credentials retry immediately', async () => {
    const f = fixture();
    await f.save('token', 'key');
    f.fail(true);
    assert.equal(await f.locate(f.socket), null);
    await f.locate(f.socket); assert.equal(f.requests.length, 1);
    f.advance(300001); await f.locate(f.socket); assert.equal(f.requests.length, 2);
    f.fail(false); await f.save('token', 'corrected');
    assert.ok(await f.locate(f.socket)); assert.equal(f.requests.length, 3);
    await f.locate(f.socket); assert.equal(f.requests.length, 3);
    f.advance(86400001); await f.locate(f.socket); assert.equal(f.requests.length, 4);
    f.databaseFail(true); assert.equal(await f.locate(f.socket), null);
});

test('private addresses and untrusted forwarding headers are not geolocated', async () => {
    const f = fixture({ SHARING_IPINFO_TOKEN: 'key' });
    for (const address of ['127.0.0.1', '::1', '::ffff:192.168.1.2', '10.1.2.3', '172.16.1.1', 'fe80::123', 'not-an-ip']) {
        assert.equal(await f.locate({ handshake: { address, headers: { 'x-forwarded-for': '8.8.8.8' } } }), null);
    }
    assert.equal(f.queries.length, 0);
    const trusted = fixture({ DYNO: 'web.1', SHARING_IPINFO_TOKEN: 'key' });
    await trusted.locate({ handshake: { address: '10.1.2.3', headers: { 'x-forwarded-for': '1.1.1.1, 8.8.8.8' } } });
    assert.ok(trusted.requests[0].url.endsWith('/8.8.8.8'));
});

test('already-connected peers acquire a region after settings are saved without leaking credentials', async () => {
    const f = fixture();
    const service = createSharing({ io: {}, now: f.now, authorize: async () => ({ _id: 'user', displayName: 'User' }), locatePeer: f.locate });
    assert.equal((await service.register(f.socket)).peers[0].region, null);
    await f.save('token', 'private-license');
    const result = await service.register(f.socket);
    assert.equal(result.peers[0].region.label, 'United States');
    assert.ok(!JSON.stringify(result).includes('private-license'));
    await f.save('token', '');
    assert.equal((await service.register(f.socket)).peers[0].region, null);
});

test('IPv6 requests use country labels and incomplete or bogon results fall back to MES', async () => {
    const f = fixture({ SHARING_IPINFO_TOKEN: 'key' });
    f.socket.handshake.address = '2001:4860:4860::8888';
    f.response({ country_code: 'CA', country: 'Canada' });
    assert.deepEqual(await f.locate(f.socket), { key: 'CA', label: 'Canada' });
    assert.equal(f.requests[0].url, 'https://api.ipinfo.io/lite/2001%3A4860%3A4860%3A%3A8888');
    for (const response of [{}, { country_code: 'US' }, { country_code: 'US', country: ' ' }, { country_code: 'USA', country: 'United States' }, { bogon: true, country_code: 'US', country: 'United States' }, null]) {
        f.advance(86400001);
        f.response(response);
        assert.equal(await f.locate(f.socket), null);
    }
});
