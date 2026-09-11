const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const express = require('express');
const sharp = require('sharp');
const md5 = require('md5');
const { Collection, ids } = require('./support/messageFixture');
const { verifyLoginPassword } = require('../utils/userAccount');

const fixture = async t => {
    class Records extends Collection {
        query(rows, single = false) {
            const query = super.query(rows, single);
            let selection;
            const lean = query.lean;
            query.select = fields => { selection = fields; return query; };
            query.session = () => query;
            query.lean = async () => {
                const result = await lean();
                if (!selection || selection.startsWith('+')) return result;
                const project = row => row && Object.fromEntries(['_id', ...selection.split(' ')].filter(key => key in row).map(key => [key, row[key]]));
                return Array.isArray(result) ? result.map(project) : project(result);
            };
            return query;
        }
        async create(input) {
            if (Array.isArray(input)) return Promise.all(input.map(record => this.create(record)));
            if (input.usernameKey && this.rows.some(row => row.usernameKey === input.usernameKey)) throw Object.assign(new Error('Duplicate'), { code: 11000 });
            return super.create(input);
        }
    }
    const db = {
        config: new Records([{ _id: 'manufacturer', key: 'manufacturer.name', scope: 'Global', status: 'Active', value: 'Down Home Manufacturing', effective: { from: new Date('2020-01-01'), to: null }, version: 1 }]),
        user: new Records([{ _id: ids.a, username: 'admin', password: 'legacy-secret', role: 'Admin', status: 'Active' }, { _id: ids.b, username: 'worker', password: 'worker-secret', role: 'User', status: 'Active' }]),
        userRegistration: new Records([], { status: 'Open' }),
        permissionCategory: new Records([{ _id: ids.topic, name: 'Office', permission: { view: ['production.run'] } }]),
    };
    let transaction = Promise.resolve();
    db.user.db = { startSession: async () => ({ endSession: async () => {}, withTransaction: async action => {
        const previous = transaction;
        let release;
        transaction = new Promise(resolve => { release = resolve; });
        await previous;
        const before = { users: structuredClone(db.user.rows), registrations: structuredClone(db.userRegistration.rows) };
        try { await action(); }
        catch (error) { db.user.rows = before.users; db.userRegistration.rows = before.registrations; throw error; }
        finally { release(); }
    } }) };
    const io = { sockets: { sockets: new Map() } };
    let session;
    const load = relative => {
        const filename = path.join(__dirname, '..', relative), module = { exports: {} };
        vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, exports: module.exports, __dirname: path.dirname(filename), process, console, Buffer, Date, setTimeout, clearTimeout,
            require: name => name.endsWith('/models') ? db : name.endsWith('/session') ? session : name.endsWith('/socket/io') ? { io }
                : name.endsWith('/userDelivery') ? load('socket/userDelivery.js') : name === '../../models/user' ? db.user : require(name.startsWith('.') ? path.resolve(path.dirname(filename), name) : name),
        }, { filename });
        return module.exports;
    };
    session = load('socket/session.js');
    const connect = id => {
        const handlers = new Map(), events = [];
        const socket = { id: String(io.sockets.sockets.size), data: {}, join() {}, leave() {}, emit: (event, payload) => events.push({ event, payload }), on: (event, handler) => handlers.set(event, handler) };
        io.sockets.sockets.set(socket.id, socket);
        if (id) session.bindSocketSession(socket, db.user.rows.find(user => user._id === id));
        load('socket/event/userRegistration.js')(socket, io);
        load('socket/event/auth.js')(socket, io);
        t.after(() => session.unbindSocketSession(socket));
        return { events, call: (event, payload = {}) => new Promise(resolve => handlers.get(event)(payload, resolve)) };
    };
    const app = express();
    app.use('/register', load('routes/userRegistration.js'));
    app.use(express.json());
    app.use('/api/login', load('api/login/index.js'));
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const post = async (action, data) => {
        const response = await fetch(`${origin}/register/api/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
        return { code: response.status, body: await response.json() };
    };
    const photo = await sharp({ create: { width: 20, height: 30, channels: 3, background: '#55aa77' } }).png().toBuffer();
    const profile = { displayName: 'New Employee', email: 'New@Example.com', username: 'new.employee', password: 'secure-test-password', portrait: `data:image/png;base64,${photo.toString('base64')}` };
    const invite = async admin => {
        const result = await admin.call('userRegistration:invite');
        assert.equal(result.status, 'success');
        assert.match(result.payload.path, /^\/register#[A-Za-z0-9_-]{10}$/);
        return { token: result.payload.path.split('#')[1], expiresAt: result.payload.expiresAt };
    };
    return { db, session, connect, post, profile, invite, origin };
};

test('single-use invitation submits a sanitized photo and provisions only after Admin approval', async t => {
    const { db, connect, post, profile, invite, origin } = await fixture(t);
    const admin = connect(ids.a), worker = connect(ids.b), anonymous = connect();
    const invitation = await invite(admin);
    assert.ok(Math.abs(new Date(invitation.expiresAt).getTime() - Date.now() - 86400000) < 2000);
    assert.notEqual(db.userRegistration.rows[0].tokenHash, invitation.token);
    const openRows = await admin.call('userRegistrations:get');
    assert.equal(openRows.payload.length, 1);
    assert.equal(openRows.payload[0].status, 'Open');
    assert.equal(openRows.payload[0].path, `/register#${invitation.token}`);
    assert.equal(openRows.payload[0].token, undefined);
    assert.equal(openRows.payload[0].tokenHash, undefined);
    assert.equal((await connect(ids.a).call('userRegistrations:get')).payload[0].path, openRows.payload[0].path);
    const page = await fetch(`${origin}/register`);
    assert.equal(page.status, 200);
    assert.ok((await page.text()).includes('<span class="brand">Down Home Manufacturing</span>'));
    assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
    assert.ok(page.headers.get('content-security-policy').includes("frame-ancestors 'none'"));
    assert.equal((await post('submit', { ...profile, token: invitation.token })).code, 200);
    assert.equal(db.user.rows.length, 2);
    const pending = db.userRegistration.rows[0];
    assert.ok(pending.password.startsWith('scrypt$'));
    assert.equal(pending.email, 'new@example.com');
    const image = await sharp(Buffer.from(pending.portrait.split(',')[1], 'base64')).metadata();
    assert.equal(image.format, 'jpeg');
    assert.ok(image.width <= 512 && image.height <= 512);
    assert.equal(await verifyLoginPassword(pending.password, md5(profile.password + 'MANUFACTURING_EXECUTION_SYSTEM')), true);
    assert.equal((await anonymous.call('auth:login', { username: profile.username, password: md5(profile.password + 'MANUFACTURING_EXECUTION_SYSTEM') })).status, 'error');
    const queue = await admin.call('userRegistrations:get');
    assert.equal(queue.payload.length, 1);
    assert.equal(queue.payload[0]._id, openRows.payload[0]._id);
    assert.equal(queue.payload[0].status, 'Submitted');
    assert.equal(queue.payload[0].path, openRows.payload[0].path);
    assert.equal(queue.payload[0].password, undefined);
    assert.equal(queue.payload[0].tokenHash, undefined);
    assert.ok(admin.events.some(item => item.event === 'userRegistrations:changed'));
    assert.equal(worker.events.some(item => item.event === 'userRegistrations:changed'), false);
    assert.equal((await post('submit', { ...profile, token: invitation.token })).code, 409);
    const result = await admin.call('userRegistration:approve', { _id: pending._id, role: 'User', permissionCategoryId: ids.topic });
    assert.equal(result.status, 'success');
    assert.equal(db.user.rows.length, 3);
    assert.equal(db.user.rows[2].permissionCategoryId, ids.topic);
    assert.equal(db.userRegistration.rows[0].password, undefined);
    assert.equal(db.userRegistration.rows[0].token, undefined);
    assert.equal((await admin.call('userRegistrations:get')).payload.length, 0);
    const login = await anonymous.call('auth:login', { username: profile.username, password: md5(profile.password + 'MANUFACTURING_EXECUTION_SYSTEM') });
    assert.equal(login.status, 'success');
    assert.equal(login.payload.user.permission.view[0], 'production.run');
    assert.equal(login.payload.user.password, undefined);
    assert.equal((await post('status', { token: invitation.token })).body.status, 'Approved');
});

test('expired, tampered and already-used links cannot create another registration', async t => {
    const { db, connect, post, profile, invite } = await fixture(t);
    const admin = connect(ids.a);
    const expired = await invite(admin);
    db.userRegistration.rows[0].expiresAt = new Date(Date.now() - 1);
    assert.equal((await post('submit', { ...profile, token: expired.token })).code, 410);
    assert.equal((await post('status', { token: '0'.repeat(10) })).code, 410);
    const fresh = await invite(admin);
    const results = await Promise.all([post('submit', { ...profile, token: fresh.token }), post('submit', { ...profile, token: fresh.token })]);
    assert.deepEqual(results.map(result => result.code).sort(), [200, 409]);
    assert.equal(db.user.rows.length, 2);
    assert.equal(db.userRegistration.rows.filter(item => item.status === 'Submitted').length, 1);
});

test('registration rejects injected permissions, bad images, duplicates and non-admin provisioning', async t => {
    const { db, connect, post, profile, invite, origin } = await fixture(t);
    const admin = connect(ids.a), worker = connect(ids.b), anonymous = connect();
    for (const actor of [worker, anonymous]) {
        assert.equal((await actor.call('userRegistration:invite')).status, 'error');
        assert.equal((await actor.call('userRegistrations:get')).status, 'error');
    }
    const { token } = await invite(admin);
    for (const changes of [{ role: 'Admin' }, { permission: { module: ['configuration'] } }, { portrait: 'data:image/svg+xml;base64,AAAA' }, { portrait: 'data:image/png;base64,AAAA' }, { email: 'invalid' }, { displayName: '' }, { password: 'short' }]) {
        assert.equal((await post('submit', { ...profile, token, ...changes })).code, 400);
    }
    assert.equal((await post('submit', { ...profile, token, username: 'ADMIN' })).code, 409);
    assert.equal((await post('submit', { ...profile, token })).code, 200);
    const pending = db.userRegistration.rows[0];
    assert.equal((await worker.call('userRegistration:approve', { _id: pending._id, role: 'Admin', permissionCategoryId: '' })).status, 'error');
    assert.equal((await admin.call('userRegistration:approve', { _id: pending._id, role: 'System', permissionCategoryId: '' })).status, 'error');
    assert.equal((await admin.call('userRegistration:approve', { _id: pending._id, role: 'User', permissionCategoryId: ids.outsider })).status, 'error');
    const bypass = await fetch(`${origin}/api/login/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...profile, role: 'Admin' }) });
    assert.equal(bypass.status, 410);
    assert.equal(db.user.rows.length, 2);
});

test('duplicate approval is atomic; rejection clears credentials without creating a user', async t => {
    const { db, connect, post, profile, invite } = await fixture(t);
    const admin = connect(ids.a), secondAdmin = connect(ids.a);
    const first = await invite(admin);
    await post('submit', { ...profile, token: first.token });
    const pending = db.userRegistration.rows[0];
    const payload = { _id: pending._id, role: 'User', permissionCategoryId: '' };
    const results = await Promise.all([admin.call('userRegistration:approve', payload), secondAdmin.call('userRegistration:approve', payload)]);
    assert.deepEqual(results.map(result => result.status).sort(), ['error', 'success']);
    assert.equal(db.user.rows.filter(user => user.username === profile.username).length, 1);
    const next = await invite(admin);
    await post('submit', { ...profile, username: 'another.employee', token: next.token });
    const rejected = db.userRegistration.rows[1];
    assert.equal((await admin.call('userRegistration:reject', { _id: rejected._id })).status, 'success');
    assert.equal(rejected.password, undefined);
    assert.equal(rejected.portrait, undefined);
    assert.equal(rejected.token, undefined);
    assert.equal((await admin.call('userRegistration:approve', { ...payload, _id: rejected._id })).status, 'error');
    assert.equal((await post('status', { token: next.token })).body.status, 'Rejected');
});

test('provisioning failure rolls back both records and a submitted application can be approved after link expiry', async t => {
    const { db, connect, post, profile, invite } = await fixture(t);
    const admin = connect(ids.a);
    const { token } = await invite(admin);
    await post('submit', { ...profile, token });
    const id = db.userRegistration.rows[0]._id;
    db.userRegistration.rows[0].expiresAt = new Date(Date.now() - 1);
    const update = db.userRegistration.updateOne.bind(db.userRegistration);
    db.userRegistration.updateOne = async () => { throw new Error('Database temporarily unavailable'); };
    const payload = { _id: id, role: 'User', permissionCategoryId: '' };
    assert.equal((await admin.call('userRegistration:approve', payload)).status, 'error');
    assert.equal(db.user.rows.length, 2);
    assert.equal(db.userRegistration.rows[0].status, 'Submitted');
    db.userRegistration.updateOne = update;
    assert.equal((await admin.call('userRegistration:approve', payload)).status, 'success');
    assert.equal(db.user.rows.length, 3);
});

test('registration branding uses only the active manufacturer name and escapes HTML', async t => {
    const { db, origin } = await fixture(t);
    db.config.rows[0].value = 'ACME <script>alert(1)</script> & Company';
    let page = await (await fetch(`${origin}/register`)).text();
    assert.ok(page.includes('ACME &lt;script&gt;alert(1)&lt;/script&gt; &amp; Company'));
    assert.equal(page.includes('<script>alert(1)</script>'), false);
    db.config.rows[0].status = 'Inactive';
    page = await (await fetch(`${origin}/register`)).text();
    assert.ok(page.includes('<span class="brand">Account registration</span>'));
});
