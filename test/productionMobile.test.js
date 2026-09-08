const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const express = require('express');
const jwt = require('jsonwebtoken');
const lineId = '111111111111111111111111';
const employeeId = '222222222222222222222222';
const secret = 'isolated-mobile-access-test';

async function fixture(t, heroku = false) {
    const state = { fail: false, assigned: true, saved: false, pin: '123456' };
    const query = get => ({ select() { return this; }, lean: async () => get() });
    const db = {
        employee: { findOne: filter => query(() => {
            if (state.fail) throw new Error('Database unavailable');
            return !filter.pin || filter.pin === state.pin ? { _id: employeeId, pin: state.pin, firstName: 'Employee' } : null;
        }) },
        productionRun: { findOne: () => query(() => state.assigned ? { _id: '333333333333333333333333', crew: [{ employeeId, enabled: true }] } : null) },
        pallet: { findOne: filter => query(() => state.saved && filter.lineId === lineId && String(filter.registeredByEmployee) === employeeId ? { _id: 'saved' } : null) },
    };
    const load = (file, deps, extra = {}) => {
        const module = { exports: {} };
        vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), { module, require: key => { if (!(key in deps)) throw new Error(key); return deps[key]; }, ...extra });
        return module.exports;
    };
    const { app, server } = load('socket/io.js', { express, http: require('http'), 'socket.io': { Server: class { use() {} } } }, { process: { env: heroku ? { DYNO: 'web.1' } : {} } });
    app.use(express.json());
    app.use(load('routes/productionMobile.js', {
        express, jsonwebtoken: jwt, 'node:crypto': require('node:crypto'), '../models': db,
        '../config/database': {}, '../utils/dayjs': {}, '../socket/session': { JWT_SECRET: secret },
        '../utils/productionMetrics': { getProductionOutput: async () => ({ totals: { pillows: 0 } }) },
        '../utils/productionPalletActions': () => ({}),
    }));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    const request = async (route, { body, token, forwarded } = {}) => {
        const result = await fetch(`http://127.0.0.1:${server.address().port}${route}`, {
            method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(forwarded ? { 'X-Forwarded-For': forwarded } : {}) },
            ...(body ? { body: JSON.stringify(body) } : {}),
        });
        return { status: result.status, data: await result.json() };
    };
    return { state, request, login: (pin = '123456', forwarded) => request('/login', { body: { lineId, pin }, forwarded }) };
}

test('database outages return 503 without invalidating a valid token', async t => {
    const { state, login, request } = await fixture(t);
    const { data: { token } } = await login();
    state.fail = true;
    assert.equal((await request('/context', { token })).status, 503);
    assert.equal((await request('/context', { token: 'invalid' })).status, 401);
    for (let i = 0; i < 20; i++) assert.equal((await login()).status, 503, 'Service errors do not consume the failed-PIN limit');
    state.fail = false;
    assert.equal((await request('/context', { token })).status, 200);
    state.pin = '999999';
    assert.equal((await request('/context', { token })).status, 401);
});

test('Heroku clients have separate limits, spoofed prefixes cannot bypass them, and successful logins do not consume failures', async t => {
    const { login } = await fixture(t, true);
    for (let i = 0; i < 20; i++) assert.equal((await login('123456', '192.0.2.1')).status, 200);
    for (let i = 0; i < 15; i++) assert.equal((await login('bad', `${i}.0.0.1, 192.0.2.1`)).status, 400);
    assert.equal((await login('bad', '203.0.113.10, 192.0.2.1')).status, 429);
    assert.equal((await login('123456', '192.0.2.2')).status, 200);
});

test('direct local servers ignore spoofed forwarded headers', async t => {
    const { login } = await fixture(t);
    for (let i = 0; i < 15; i++) assert.equal((await login('bad', `192.0.2.${i}`)).status, 400);
    assert.equal((await login('bad', '192.0.2.99')).status, 429);
});

test('recovery login requires an owned pallet and exposes no other crew run', async t => {
    const { state, login, request } = await fixture(t);
    state.assigned = false;
    assert.equal((await login()).status, 403);
    state.saved = true;
    const session = await login();
    assert.equal(session.status, 200);
    const context = await request('/context', { token: session.data.token });
    assert.equal(context.status, 200);
    assert.equal(context.data.run, null);
    assert.equal(context.data.recoveryOnly, true);
});
