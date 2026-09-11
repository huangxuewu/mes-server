const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const test = require('node:test');

const fixture = () => {
    const records = new Map();
    let actor = { _id: 'user-a' };
    const handlers = {};
    const model = {
        findOne: query => ({ lean: async () => records.get(query.userId) || null }),
        updateOne: async (query, update) => records.set(query.userId, JSON.parse(JSON.stringify(update.$set))),
    };
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../socket/event/dashboard.js'), 'utf8'), {
        module, require: name => name === '../../models' ? { dashboard: model } : {
            getActiveSessionUser: async () => { if (!actor) throw new Error('Session expired'); return actor; },
        },
    });
    module.exports({ on: (name, handler) => { handlers[name] = handler; } });
    return { records, user: value => { actor = value; }, call: (event, payload) => new Promise(resolve => handlers[event](payload, resolve)) };
};
const layout = () => ({ version: 1, widgets: [{ id: 'one', type: 'hours', size: 'large', x: 0, y: 0,
    settings: { departmentId: '', teamId: '', week: 'current' } }] });

test('dashboard reads and writes only the authenticated account', async () => {
    const f = fixture();
    assert.equal((await f.call('dashboard:get', {})).payload, null);
    assert.equal((await f.call('dashboard:update', layout())).status, 'success');
    f.user({ _id: 'user-b' });
    assert.equal((await f.call('dashboard:get', { userId: 'user-a' })).payload, null);
    assert.equal((await f.call('dashboard:update', { ...layout(), userId: 'user-a' })).status, 'error');
    f.user(null);
    assert.equal((await f.call('dashboard:get', {})).status, 'error');
    assert.equal((await f.call('dashboard:update', layout())).status, 'error');
    assert.equal(f.records.size, 1);
});

test('duplicate types are independent and an intentionally empty dashboard remains empty', async () => {
    const f = fixture();
    const data = layout();
    data.widgets.push({ ...data.widgets[0], id: 'two', y: 4, settings: { week: 'previous' } });
    assert.equal((await f.call('dashboard:update', data)).status, 'success');
    assert.equal((await f.call('dashboard:get', {})).payload.widgets.length, 2);
    await f.call('dashboard:update', { version: 1, widgets: [] });
    assert.equal((await f.call('dashboard:get', {})).payload.widgets.length, 0);
});

test('malformed layouts, unsupported sizes, invalid settings and ownership fields never overwrite a dashboard', async () => {
    const f = fixture();
    await f.call('dashboard:update', layout());
    for (const mutate of [
        d => { d.version = 2; }, d => { d.widgets[0].type = 'unknown'; }, d => { d.widgets[0].size = 'small'; },
        d => { d.widgets[0].x = 8; }, d => { d.widgets[0].y = -1; }, d => { d.widgets[0].y = 1.5; },
        d => { d.widgets[0].settings.week = 'next-year'; }, d => { d.widgets[0].settings.departmentId = { $ne: '' }; },
        d => { d.widgets[0].settings.secret = true; }, d => { d.widgets.push({ ...d.widgets[0] }); },
        d => { d.widgets[0].settings = []; }, d => { d.widgets = null; }, d => { d.widgets = Array(51).fill(d.widgets[0]); },
    ]) {
        const data = layout(); mutate(data);
        assert.equal((await f.call('dashboard:update', data)).status, 'error');
    }
    assert.equal(f.records.get('user-a').widgets[0].settings.week, 'current');
});
