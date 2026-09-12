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

test('interaction round-trips for every widget, accepts legacy omission and rejects non-booleans', async () => {
    const f = fixture();
    for (const type of ['attendance', 'hours', 'shipping', 'inbound', 'outbound', 'agenda']) {
        const data = layout();
        Object.assign(data.widgets[0], { type, size: 'medium', settings: {} });
        assert.equal((await f.call('dashboard:update', data)).status, 'success');
        for (const interaction of [true, false]) {
            data.widgets[0].settings.interaction = interaction;
            assert.equal((await f.call('dashboard:update', data)).status, 'success');
            assert.equal((await f.call('dashboard:get', {})).payload.widgets[0].settings.interaction, interaction);
        }
        for (const interaction of ['true', 1, null, {}, []]) {
            data.widgets[0].settings.interaction = interaction;
            assert.equal((await f.call('dashboard:update', data)).status, 'error');
        }
    }
});

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
        d => { d.widgets[0].x = 8; }, d => { d.widgets[0].y = -1; }, d => { d.widgets[0].y = 1.1; },
        d => { d.widgets[0].y = '1'; }, d => { d.widgets[0].y = null; },
        d => { d.widgets[0].w = 13; }, d => { d.widgets[0].w = 3; }, d => { d.widgets[0].w = 4.5; },
        d => { d.widgets[0].h = 1; }, d => { d.widgets[0].h = 21; }, d => { d.widgets[0].h = 2.1; },
        d => { d.widgets[0].w = null; }, d => { d.widgets[0].h = '4'; },
        d => { d.widgets[0].w = 10; d.widgets[0].x = 3; },
        d => { d.widgets[0].settings.week = 'next-year'; }, d => { d.widgets[0].settings.departmentId = { $ne: '' }; },
        d => { d.widgets[0].settings.secret = true; }, d => { d.widgets.push({ ...d.widgets[0] }); },
        d => { d.widgets[0].settings = []; }, d => { d.widgets = null; }, d => { d.widgets = Array(51).fill(d.widgets[0]); },
    ]) {
        const data = layout(); mutate(data);
        assert.equal((await f.call('dashboard:update', data)).status, 'error');
    }
    assert.equal(f.records.get('user-a').widgets[0].settings.week, 'current');
});

test('shipping period selections round-trip and invalid period lists are rejected', async () => {
    const f = fixture();
    const data = layout();
    data.widgets[0].type = 'shipping';
    data.widgets[0].settings = { unit: 'box', periods: ['thisWeek', 'nextWeek', 'future'] };
    for (const periods of [['thisWeek', 'nextWeek', 'future'], ['nextWeek'], []]) {
        data.widgets[0].settings.periods = periods;
        assert.equal((await f.call('dashboard:update', data)).status, 'success');
        assert.deepEqual((await f.call('dashboard:get', {})).payload.widgets[0].settings.periods, periods);
    }
    for (const periods of ['thisWeek', null, ['09/11'], ['thisWeek', 'thisWeek'], ['future', 'unknown']]) {
        data.widgets[0].settings.periods = periods;
        assert.equal((await f.call('dashboard:update', data)).status, 'error');
    }
});

test('auto-expansion round-trips for every widget and rejects non-booleans', async () => {
    const f = fixture();
    for (const type of ['attendance', 'hours', 'shipping', 'inbound', 'outbound', 'agenda']) {
        const data = layout();
        Object.assign(data.widgets[0], { type, size: 'medium', h: 3.25, settings: {} });
        for (const autoExpand of [true, false]) {
            data.widgets[0].settings.autoExpand = autoExpand;
            assert.equal((await f.call('dashboard:update', data)).status, 'success');
            const saved = (await f.call('dashboard:get', {})).payload.widgets[0];
            assert.equal(saved.settings.autoExpand, autoExpand);
            assert.equal(saved.h, 3.25);
        }
        for (const autoExpand of ['true', 1, null, {}]) {
            data.widgets[0].settings.autoExpand = autoExpand;
            assert.equal((await f.call('dashboard:update', data)).status, 'error');
        }
    }
});

test('metric visibility round-trips for each metric widget and rejects non-booleans', async () => {
    const f = fixture();
    for (const type of ['attendance', 'hours', 'shipping', 'inbound', 'outbound']) {
        const data = layout();
        Object.assign(data.widgets[0], { type, size: 'medium', settings: {} });
        for (const hideMetrics of [true, false]) {
            data.widgets[0].settings.hideMetrics = hideMetrics;
            assert.equal((await f.call('dashboard:update', data)).status, 'success');
            assert.equal((await f.call('dashboard:get', {})).payload.widgets[0].settings.hideMetrics, hideMetrics);
        }
        for (const hideMetrics of ['true', 1, null, {}]) {
            data.widgets[0].settings.hideMetrics = hideMetrics;
            assert.equal((await f.call('dashboard:update', data)).status, 'error');
        }
    }
});

test('custom widget dimensions round-trip independently of their original preset', async () => {
    const f = fixture();
    const data = layout();
    Object.assign(data.widgets[0], { x: 2, y: 1.25, w: 10, h: 7.5 });
    assert.equal((await f.call('dashboard:update', data)).status, 'success');
    const saved = (await f.call('dashboard:get', {})).payload.widgets[0];
    assert.equal(saved.w, 10);
    assert.equal(saved.h, 7.5);
    assert.equal(saved.y, 1.25);
    assert.equal(saved.size, 'large');
});

test('outbound widgets save their own status filters and fine dimensions', async () => {
    const f = fixture();
    const data = layout();
    Object.assign(data.widgets[0], { type: 'outbound', size: 'medium', w: 4, h: 4.25, y: 0.5 });
    for (const status of ['', 'Pending', 'Carrier Accepted, Awaiting Pickup', 'Past Pickup', 'Picked Up', 'Completed', 'Cancelled']) {
        data.widgets[0].settings = { range: 'week', status };
        assert.equal((await f.call('dashboard:update', data)).status, 'success');
        assert.deepEqual((await f.call('dashboard:get', {})).payload.widgets[0], data.widgets[0]);
    }
    data.widgets[0].settings.status = 'Receiving';
    assert.equal((await f.call('dashboard:update', data)).status, 'error');
    data.widgets[0].type = 'outbound';
    for (const range of ['today', 'threeDays', 'currentWeek', 'week']) {
        data.widgets[0].settings = { range, status: '' };
        assert.equal((await f.call('dashboard:update', data)).status, 'success');
        assert.equal((await f.call('dashboard:get', {})).payload.widgets[0].settings.range, range);
    }
    data.widgets[0].settings.range = 'month';
    assert.equal((await f.call('dashboard:update', data)).status, 'error');
    data.widgets[0].type = 'inbound';
    data.widgets[0].settings.status = 'Picked Up';
    assert.equal((await f.call('dashboard:update', data)).status, 'error');
});


test('sales invoice widget sizes and common settings persist', async () => {
    const f = fixture();
    for (const size of ['small', 'medium', 'large']) {
        const data = { version: 1, widgets: [{ id: 'invoice', type: 'salesInvoice', size, x: 0, y: 0,
            settings: { hideMetrics: false, interaction: true, autoExpand: false } }] };
        assert.equal((await f.call('dashboard:update', data)).status, 'success');
        assert.equal((await f.call('dashboard:get', {})).payload.widgets[0].type, 'salesInvoice');
    }
});
