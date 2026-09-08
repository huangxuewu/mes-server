const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const jwt = require('jsonwebtoken');
const { Collection, ids } = require('./support/messageFixture');
const fixture = () => {
    const db = { user: new Collection([{ _id: ids.a, username: 'admin', password: 'hashed-secret', displayName: 'Admin', status: 'Active', role: 'Admin', permission: { view: ['document.article.view'] } },
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
    let socketSequence = 0;
    const connect = userId => {
        const handlers = new Map(), received = [], rooms = new Set();
        const socket = { id: `socket-${++socketSequence}`, data: {}, on: (name, handler) => handlers.set(name, handler), emit: (event, payload) => received.push({ event, payload }), join: room => rooms.add(room), leave: room => rooms.delete(room) };
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

test('permission changes refresh access and subscriptions without ending the session or exposing credentials', async () => {
    const { connect, session, db } = fixture(), worker = connect(ids.b);
    const roster = await worker.call('users:get', {});
    assert.equal(roster.status, 'success');
    assert.equal(roster.payload[0].password, undefined);
    assert.equal(roster.payload[0].permission, undefined);
    assert.ok(roster.payload[1].permission);
    const { sessionGeneration, expiresAt, expiryTimer } = worker.socket.data;
    const previousSignature = worker.socket.data.sessionSignature;
    const changed = [], ended = [];
    session.onPermissionsChanged(id => changed.push(id));
    session.onSessionEnded(id => ended.push(id));
    db.user.rows[1].permission = { view: ['new-permission', 'office.calendar.event.public.view'] };
    const refreshed = await session.getActiveSessionUser(worker.socket);
    assert.equal(session.hasPermission(refreshed, 'view', 'new-permission'), true);
    assert.equal(worker.rooms.has(session.PUBLIC_EVENT_ROOM), true);
    assert.notEqual(worker.socket.data.sessionSignature, previousSignature);
    assert.equal(worker.socket.data.sessionGeneration, sessionGeneration);
    assert.equal(worker.socket.data.expiresAt, expiresAt);
    assert.equal(worker.socket.data.expiryTimer, expiryTimer);
    assert.equal(session.isBoundDocumentSession(worker.socket.id, ids.b, sessionGeneration), true);
    assert.deepEqual(changed, [worker.socket.id]);
    assert.equal(ended.length, 0);
    assert.equal(worker.received.at(-1).event, 'auth:permissions');
    assert.equal(worker.received.at(-1).payload.password, undefined);
    db.user.rows[1].permission = { view: [] };
    assert.equal(session.hasPermission(await session.getActiveSessionUser(worker.socket), 'view', 'new-permission'), false);
    assert.equal(worker.rooms.has(session.PUBLIC_EVENT_ROOM), false);
    assert.equal(worker.received.some(item => item.event === 'auth:revoked'), false);
    worker.close();
});

test('permission saves succeed for self and other accounts even when the database broadcast precedes acknowledgment', async t => {
    const { connect, session, db, load } = fixture(), admin = connect(ids.a), worker = connect(ids.b), workerOtherStation = connect(ids.b);
    const clients = [admin, worker, workerOtherStation];
    t.after(() => clients.forEach(client => client.close()));
    const before = clients.map(client => ({ generation: client.socket.data.sessionGeneration, expiresAt: client.socket.data.expiresAt }));
    const io = { sockets: { sockets: new Map(clients.map(client => [client.socket.id, client.socket])) } };
    const updateOne = db.user.updateOne.bind(db.user);
    db.user.updateOne = async (...args) => {
        const result = await updateOne(...args);
        await load('socket/userDelivery.js').deliverUserChange(io, 'user:update', db.user.rows.find(user => user._id === args[0]._id));
        return result;
    };
    for (const target of [ids.a, ids.b]) {
        assert.equal((await admin.call('user:update', { _id: target, permission: { update: ['production.run'] } })).status, 'success');
        assert.equal(db.user.rows.find(user => user._id === target).permission.update[0], 'production.run');
    }
    for (const [index, client] of clients.entries()) {
        assert.equal(client.socket.data.sessionGeneration, before[index].generation);
        assert.equal(client.socket.data.expiresAt, before[index].expiresAt);
        assert.equal(client.received.some(item => item.event === 'auth:revoked'), false);
        assert.ok(client.received.some(item => item.event === 'auth:permissions' && item.payload.permission.update.includes('production.run')));
        assert.equal((await client.call('users:get', {})).status, 'success');
    }
    assert.equal((await admin.call('user:update', { _id: ids.b, permission: {} })).status, 'success');
    assert.equal(session.hasPermission(await session.getActiveSessionUser(worker.socket), 'update', 'production.run'), false);
    assert.equal(session.hasPermission(await session.getActiveSessionUser(workerOtherStation.socket), 'update', 'production.run'), false);
});

test('credential, role and account status changes still revoke a bound session', async () => {
    for (const change of [{ username: 'renamed' }, { password: 'replaced' }, { role: 'Manager' }, { status: 'Disabled' }]) {
        const { connect, db, session } = fixture(), worker = connect(ids.b);
        try {
            Object.assign(db.user.rows[1], change);
            await assert.rejects(session.getActiveSessionUser(worker.socket), /no longer valid/);
            assert.equal(worker.received.at(-1).event, 'auth:revoked');
            assert.equal(worker.socket.data.userId, null);
            assert.equal(session.isBoundDocumentSession(worker.socket.id, ids.b), false);
        } finally { worker.close(); }
    }
});

test('ordinary users cannot change security fields or other accounts; Admin edits preserve blank passwords', async () => {
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

test('Admin can manage non-System accounts and read their permissions without password exposure', async () => {
    const { connect, db } = fixture();
    db.user.rows[0].role = 'System';
    db.user.rows.push({ _id: ids.outsider, username: 'factory-admin', role: 'Admin', status: 'Active', permission: {} });
    const admin = connect(ids.outsider);
    try {
        const roster = await admin.call('users:get', {});
        assert.ok(roster.payload.find(user => user._id === ids.b).permission);
        assert.equal(roster.payload.find(user => user._id === ids.a).permission, undefined);
        assert.equal(JSON.stringify(roster.payload).includes('worker-secret'), false);
        const permission = { update: ['production.run'] };
        assert.equal((await admin.call('user:update', { _id: ids.b, permission })).status, 'success');
        assert.equal(db.user.rows.find(user => user._id === ids.b).permission.update[0], 'production.run');
        assert.equal((await admin.call('user:create', { username: 'new-operator', password: 'test-only-password', role: 'User' })).status, 'success');
        const created = db.user.rows.find(user => user.username === 'new-operator');
        assert.equal((await admin.call('user:delete', { _id: created._id })).status, 'success');
    } finally { admin.close(); }
});

test('Admin has full operator permissions but cannot become System or edit MES-owned System records', async () => {
    const { connect, db, session } = fixture();
    db.user.rows[0].role = 'System';
    db.user.rows.push({ _id: ids.outsider, username: 'factory-admin', role: 'Admin', status: 'Active', permission: {} });
    const admin = connect(ids.outsider);
    try {
        for (const [event, payload] of [
            ['user:update', { _id: ids.outsider, role: 'System' }],
            ['user:update', { _id: ids.a, password: 'replaced-password' }],
            ['user:update', { _id: ids.a, role: 'User' }],
            ['user:delete', { _id: ids.a }],
            ['user:create', { username: 'elevated', password: 'test-only-password', role: 'System' }],
        ]) assert.equal((await admin.call(event, payload)).status, 'error');
        assert.equal(db.user.writes.length, 0);
        assert.equal((await admin.call('user:update', { _id: ids.outsider, permission: { update: ['production.run'] } })).status, 'success');
        const updated = db.user.rows.find(user => user._id === ids.outsider);
        assert.equal(updated.role, 'Admin');
        assert.equal(session.hasPermission(updated, 'update', 'production.run'), true);
        assert.equal(session.hasPermission(updated, 'delete', 'ungranted.resource'), true);
        assert.equal(session.hasPermission({ ...updated, role: 'Manager', permission: {} }, 'update', 'production.run'), false);
        assert.equal((await session.getActiveSessionUser(admin.socket))._id, ids.outsider);
        assert.equal(admin.received.some(item => item.event === 'auth:revoked'), false);
    } finally { admin.close(); }
});

test('Admin account updates cannot modify a target promoted to System during the request', async () => {
    const { connect, db } = fixture();
    db.user.rows.push({ _id: ids.outsider, username: 'factory-admin', role: 'Admin', status: 'Active', permission: {} });
    const admin = connect(ids.outsider);
    const updateOne = db.user.updateOne.bind(db.user);
    db.user.updateOne = async (...args) => { db.user.rows.find(user => user._id === ids.b).role = 'System'; return updateOne(...args); };
    try {
        assert.equal((await admin.call('user:update', { _id: ids.b, displayName: 'Changed' })).status, 'error');
        assert.equal(db.user.rows.find(user => user._id === ids.b).displayName, 'Worker');
    } finally { admin.close(); }
});

test('Admin roster broadcasts include managed permissions and exclude protected System permissions', async () => {
    const { connect, db, load } = fixture();
    db.user.rows[0].role = 'System';
    db.user.rows.push({ _id: ids.outsider, username: 'factory-admin', role: 'Admin', status: 'Active', permission: {} });
    const admin = connect(ids.outsider);
    const io = { sockets: { sockets: new Map([['admin', admin.socket]]) } };
    try {
        await load('socket/userDelivery.js').deliverUserChange(io, 'user:update', db.user.rows[1]);
        assert.ok(admin.received.at(-1).payload.permission);
        await load('socket/userDelivery.js').deliverUserChange(io, 'user:update', db.user.rows[0]);
        assert.equal(admin.received.at(-1).payload.permission, undefined);
        assert.equal(JSON.stringify(admin.received).includes('worker-secret'), false);
    } finally { admin.close(); }
});

test('System is an MES actor, not an operator account administrator', async () => {
    const { connect, db, session } = fixture();
    db.user.rows[0].role = 'System';
    const system = connect(ids.a);
    try {
        assert.equal(session.canAdministerAccounts(db.user.rows[0]), false);
        assert.equal(session.hasPermission(db.user.rows[0], 'create', 'mes.action'), true);
        assert.equal((await system.call('user:create', { username: 'operator', password: 'test-only-password', role: 'Admin' })).status, 'error');
        assert.equal((await system.call('user:update', { _id: ids.a, displayName: 'Human admin' })).status, 'error');
        assert.equal(db.user.writes.length, 0);
    } finally { system.close(); }
});
