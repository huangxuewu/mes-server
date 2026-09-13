const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const phoneSharing = require('../socket/phoneSharing');

const key = 'integration.sharing.publicUrl';
const fixture = () => {
    let record, databaseFailed = false;
    const queries = [];
    const db = { config: {
        find: () => ({ maxTimeMS: () => ({ lean: async () => [] }) }),
        findOne: query => {
            queries.push(query);
            return { maxTimeMS: timeout => {
                assert.equal(timeout, 1500);
                return { lean: async () => {
                    if (databaseFailed) throw new Error('Database unavailable');
                    return record?.key === query.key && record.scope === query.scope && record.status === query.status
                        && record.effective.from <= query['effective.from'].$lte
                        && (!record.effective.to || record.effective.to >= query.$or[1]['effective.to'].$gte) ? record : null;
                } };
            } };
        },
        findOneAndUpdate: async (query, update, options) => {
            assert.equal(query.key, key);
            assert.equal(query.scope, 'Global');
            assert.equal(options.upsert, true);
            assert.equal(options.runValidators, true);
            record = { ...(record || { key, ...update.$setOnInsert }), ...update.$set };
            return record;
        },
    } };
    const context = { module: { exports: {} }, Date, require: name => {
        if (name === '../../models') return db;
        if (name === '../phoneSharing') return phoneSharing;
        if (name.endsWith('stationScreenshots')) return { getStationScreenshots: () => ({}) };
        if (name.endsWith('stationLive')) return { getStationLive: () => ({}) };
        if (name.endsWith('stationRoster')) return { getStationRoster: () => ({}) };
        return {};
    } };
    vm.runInNewContext(fs.readFileSync(require.resolve('../socket/event/config'), 'utf8'), context);
    const handlers = {};
    context.module.exports({ on: (event, handler) => { handlers[event] = handler; } }, {});
    const desktop = { id: 'desktop', connected: true, emit() {} };
    const owner = { socket: desktop, user: { _id: 'user' } };
    const phone = phoneSharing.createPhoneSharing({ db, getOwner: () => owner, active: () => desktop.connected, publish() {}, renderQr: async () => 'image' });
    return { phone, desktop, queries,
        save: value => new Promise(resolve => handlers['config:update']({ key, value }, resolve)),
        create: () => phone.create(desktop), record: () => record,
        replace: value => { record = value; }, databaseFail: () => { databaseFailed = true; },
    };
};

test('saving creates the global record; new invitations immediately use database changes', async () => {
    const f = fixture();
    assert.equal((await f.save(' https://mes.example/sharing ')).status, 'success');
    assert.equal(f.record()._id, `cfg.${key}`);
    assert.equal(f.record().type, 'String');
    const first = await f.create();
    assert.equal(new URL(first.url).origin, 'https://mes.example');
    await f.save('https://new.example/sharing/');
    assert.deepEqual(await f.create(), first, 'an active invitation keeps its URL');
    f.phone.cancel(f.desktop, { id: first.id });
    assert.equal(new URL((await f.create()).url).origin, 'https://new.example');
});

test('invalid URLs cannot be saved or used even when inserted directly into the database', async () => {
    const f = fixture();
    await f.save('https://mes.example/sharing');
    const valid = f.record();
    for (const value of [null, {}, 17, 'http://mes.example/sharing', 'https://mes.example/', 'https://a:b@mes.example/sharing',
        'https://mes.example/sharing?foo=bar', 'https://mes.example/sharing#secret', 'https://mes.example/sharing?',
        'https://mes.example/sharing#', 'https://mes.example/sharing\n/ignored', `https://${'a'.repeat(2050)}.example/sharing`]) {
        assert.equal((await f.save(value)).status, 'error');
        f.replace({ ...valid, value });
        await assert.rejects(f.create(), /phoneConfiguration/);
        f.replace(valid);
    }
});

test('missing, cleared, inactive, scoped and ineffective records never fall back to a runtime URL', async t => {
    const previous = process.env.SHARING_PUBLIC_URL;
    process.env.SHARING_PUBLIC_URL = 'https://runtime.example/sharing';
    t.after(() => { if (previous === undefined) delete process.env.SHARING_PUBLIC_URL; else process.env.SHARING_PUBLIC_URL = previous; });
    const f = fixture();
    await assert.rejects(f.create(), /phoneConfiguration/);
    await f.save('https://mes.example/sharing');
    const valid = f.record();
    for (const change of [{ status: 'Inactive' }, { scope: 'User' }, { effective: { from: new Date(Date.now() + 60000) } },
        { effective: { from: new Date(0), to: new Date(1) } }]) {
        f.replace({ ...valid, ...change });
        await assert.rejects(f.create(), /phoneConfiguration/);
    }
    f.replace(valid);
    assert.equal((await f.save('')).status, 'success');
    await assert.rejects(f.create(), /phoneConfiguration/);
    f.databaseFail();
    await assert.rejects(f.create(), /phoneUnavailable/);
});

test('desktop departure during the database read cannot create an invitation', async () => {
    let finish, owner = { socket: { id: 'desktop', connected: true } };
    const desktop = owner.socket;
    const phone = phoneSharing.createPhoneSharing({
        db: { config: { find: () => ({ maxTimeMS: () => ({ lean: async () => [] }) }), findOne: () => ({ maxTimeMS: () => ({ lean: () => new Promise(resolve => { finish = resolve; }) }) }) } },
        getOwner: () => owner, active: entry => !!entry?.socket.connected, publish() {}, renderQr: () => assert.fail('Must not render a QR'),
    });
    const pending = phone.create(desktop);
    await new Promise(resolve => setImmediate(resolve));
    owner = { socket: desktop };
    finish({ value: 'https://mes.example/sharing' });
    await assert.rejects(pending, /phoneUnavailable/);
});
