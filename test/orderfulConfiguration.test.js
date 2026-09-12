const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');

const key = 'integration.edi.orderfulApiKey';
const fixture = () => {
    const records = new Map();
    const db = { config: {
        findOneAndUpdate: async ({ key }, update, options) => {
            const previous = records.get(key);
            if (!previous && !options.upsert) return null;
            const record = { ...(previous || { key, ...update.$setOnInsert }), ...update.$set };
            records.set(key, record);
            return options.new ? record : previous;
        },
    } };
    const context = { module: { exports: {} }, Date, require: name => {
        if (name === '../../models') return db;
        if (name.endsWith('stationScreenshots')) return { getStationScreenshots: () => ({}) };
        if (name.endsWith('stationLive')) return { getStationLive: () => ({}) };
        if (name.endsWith('stationRoster')) return { getStationRoster: () => ({}) };
        return {};
    } };
    vm.runInNewContext(fs.readFileSync(require.resolve('../socket/event/config'), 'utf8'), context);
    const handlers = {};
    context.module.exports({ on: (event, handler) => { handlers[event] = handler; } }, {});
    const save = value => new Promise(resolve => handlers['config:update']({ key, value }, resolve));
    return { records, save };
};

test('first Orderful key save creates an active setting without startup seeding', async () => {
    const f = fixture();
    const result = await f.save(' sample-key ');
    assert.equal(result.status, 'success');
    assert.equal(result.payload.key, key);
    assert.equal(result.payload.value, 'sample-key');
    const saved = f.records.get(key);
    assert.equal(saved._id, `cfg.${key}`);
    assert.equal(saved.type, 'String');
    assert.equal(saved.scope, 'Global');
    assert.equal(saved.status, 'Active');
    assert.ok(saved.effective.from <= new Date());
    assert.equal(saved.version, 1);
});

test('Orderful key can be replaced and cleared without duplicating the setting', async () => {
    const f = fixture();
    await f.save('original-key');
    const original = f.records.get(key);
    for (const value of ['replacement-key', '']) {
        const result = await f.save(value);
        assert.equal(result.status, 'success');
        assert.equal(result.payload.value, value);
        assert.equal(f.records.get(key).value, value);
        assert.equal(result.payload._id, original._id);
        assert.equal(result.payload.effective.from, original.effective.from);
        assert.equal(f.records.size, 1);
    }
});

test('non-text Orderful keys are rejected without changing the saved credential', async () => {
    const f = fixture();
    await f.save('original-key');
    for (const value of [null, 123, { key: 'invalid' }]) {
        assert.equal((await f.save(value)).status, 'error');
        assert.equal(f.records.get(key).value, 'original-key');
    }
});
