const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const jwt = require('jsonwebtoken');
const { Collection, ids } = require('./support/messageFixture');
const fixture = () => {
    const db = { user: new Collection([{ _id: ids.a, username: 'admin', password: 'hashed-secret', displayName: 'Admin', status: 'Active', role: 'System', permission: { view: ['document.article.view'] } },
        { _id: ids.b, username: 'worker', password: 'worker-secret', displayName: 'Worker', status: 'Active', role: 'User', permission: { view: [] } }]) };
    let session;
    const load = relative => {
        const filename = path.join(__dirname, '..', relative), module = { exports: {} };
        vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, exports: module.exports, process: { env: { JWT_SECRET: 'test-only-secret' } }, setTimeout, clearTimeout, Date, console,
            require: name => name.endsWith('/models') ? db : name.endsWith('/session') ? session : require(name.startsWith('.') ? path.resolve(path.dirname(filename), name) : name),
        }, { filename });
        return module.exports;
    };
    session = load('socket/session.js');
    const connect = userId => {
        const handlers = new Map(), received = [], rooms = new Set();
        const socket = { data: {}, on: (name, handler) => handlers.set(name, handler), emit: (event, payload) => received.push({ event, payload }), join: room => rooms.add(room), leave: room => rooms.delete(room) };
        if (userId) session.bindSocketSession(socket, db.user.rows.find(user => user._id === userId));
        load('socket/event/auth.js')(socket, {}); load('socket/event/user.js')(socket, {});
        return { socket, received, rooms, close: () => session.unbindSocketSession(socket), call: (event, input) => new Promise(resolve => handlers.get(event)(input, resolve)) };
    };
    return { db, session, connect, load };
};

test('login rejects query injection and disabled accounts, and never returns passwords', async () => {
    const { connect, db } = fixture(), actor = connect();
    assert.equal((await actor.call('auth:login', { username: { $ne: '' }, password: { $ne: '' } })).status, 'error');
    const login = await actor.call('auth:login', { username: 'admin', password: 'hashed-secret' });
    assert.equal(login.status, 'success');
    assert.equal(login.payload.user.password, undefined);
    db.user.rows[0].status = 'Disabled';
    assert.equal((await actor.call('auth:login', { username: 'admin', password: 'hashed-secret' })).status, 'error');
    assert.equal(actor.socket.data.userId, null);
    actor.close();
});

test('failed token rebind clears the previous account and session expiry denies access', async () => {
    const { connect, session } = fixture(), actor = connect(ids.a);
    assert.equal((await actor.call('auth:bind', { token: 'invalid' })).status, 'error');
    assert.equal(actor.socket.data.userId, null);
    assert.equal(actor.rooms.size, 0);
    const token = jwt.sign({ id: ids.a }, 'test-only-secret', { expiresIn: '1h' });
    assert.equal((await actor.call('auth:bind', { token })).status, 'success');
    actor.socket.data.expiresAt = Date.now() - 1;
    await assert.rejects(session.getActiveSessionUser(actor.socket), /Sign in/);
    actor.close();
});

test('account changes revoke bound sessions and roster projections exclude private permissions', async () => {
    const { connect, session, db } = fixture(), worker = connect(ids.b);
    const roster = await worker.call('users:get', {});
    assert.equal(roster.status, 'success');
    assert.equal(roster.payload[0].password, undefined);
    assert.equal(roster.payload[0].permission, undefined);
    assert.ok(roster.payload[1].permission);
    db.user.rows[1].permission = { view: ['new-permission'] };
    await assert.rejects(session.getActiveSessionUser(worker.socket), /no longer valid/);
    assert.equal(worker.received.at(-1).event, 'auth:revoked');
    worker.close();
});

test('ordinary users cannot change security fields or other accounts; System edits preserve blank passwords', async () => {
    const { connect, db } = fixture(), worker = connect(ids.b), admin = connect(ids.a), anonymous = connect();
    assert.equal((await anonymous.call('users:get', {})).status, 'error');
    assert.equal((await worker.call('user:update', { _id: ids.b, role: 'System' })).status, 'error');
    assert.equal((await worker.call('user:update', { _id: ids.a, displayName: 'Hijacked' })).status, 'error');
    assert.equal(db.user.writes.length, 0);
    assert.equal((await worker.call('user:update', { _id: ids.b, displayName: 'Sam' })).status, 'success');
    assert.equal((await admin.call('user:update', { _id: ids.b, displayName: 'Sam Lee', password: '', confirmPassword: '' })).status, 'success');
    assert.equal(db.user.rows[1].password, 'worker-secret');
    worker.close(); admin.close(); anonymous.close();
});

test('account broadcasts provide one correct projection per authenticated recipient', async () => {
    const { connect, db, load } = fixture(), admin = connect(ids.a), worker = connect(ids.b), anonymous = connect();
    const io = { sockets: { sockets: new Map([['a', admin.socket], ['b', worker.socket], ['none', anonymous.socket]]) } };
    await load('socket/userDelivery.js').deliverUserChange(io, 'user:update', db.user.rows[0]);
    assert.equal(admin.received.length, 1);
    assert.equal(worker.received.length, 1);
    assert.equal(anonymous.received.length, 0);
    assert.ok(admin.received[0].payload.permission);
    assert.equal(worker.received[0].payload.permission, undefined);
    assert.equal(JSON.stringify(admin.received).includes('hashed-secret'), false);
    admin.close(); worker.close(); anonymous.close();
});
