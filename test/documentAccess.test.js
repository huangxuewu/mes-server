const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const jwt = require('jsonwebtoken');
const owner = { _id: '111111111111111111111111', role: 'User', status: 'Active', permission: { module: ['document'] } };
const viewer = { ...owner, _id: '222222222222222222222222' };
const outsider = { ...owner, _id: '333333333333333333333333' };
const document = { _id: 'aaaaaaaaaaaaaaaaaaaaaaaa', owner: owner._id, visibility: 'selected', viewerIds: [viewer._id], securityVersion: 2, title: 'Private', passwordHash: 'never return' };
const fixture = () => {
    let current = { ...document };
    const db = { document: { findById: () => ({ lean: async () => current }), find: () => ({ lean: async () => [] }) },
        documentComment: { findById: () => ({ select: () => ({ lean: async () => ({ document: document._id }) }) }) } };
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(require.resolve('../utils/documentAccess'), 'utf8'), { module, console, require: name => {
        if (name === '../models') return db;
        if (name === '../socket/session') return { JWT_SECRET: 'test-key', isBoundDocumentSession: () => true, getActiveSessionUser: async socket => { if (socket.revoked) throw Error('revoked'); return socket.user; },
            hasPermission: require('../socket/session').hasPermission };
        return require(name);
    } });
    const socket = user => ({ user, data: { documentSeen: new Set([document._id]) }, handlers: {}, received: [],
        on(event, fn) { this.handlers[event] = fn; }, emit(event, payload) { this.received.push({ event, payload }); } });
    return { ...module.exports, socket, setDocument: value => { current = value; } };
};

test('selected people, manager recovery and passwords are enforced independently', () => {
    const access = fixture();
    assert.equal(access.canView(owner, document), true);
    assert.equal(access.canView(viewer, document), true);
    assert.equal(access.canView(outsider, document), false);
    assert.equal(access.canView({ ...viewer, status: 'Disabled' }, document), false);
    assert.equal(access.canView({ ...outsider, role: 'System' }, document), true);
    assert.equal(access.canView({ ...outsider, role: 'Admin', permission: {} }, document), true);
    assert.equal(access.canManage({ ...outsider, role: 'Admin' }, document), true);
    assert.equal(access.canManage({ ...outsider, role: 'Manager' }, document), false);
    const protectedDocument = { ...document, hasPassword: true };
    assert.throws(() => access.assertAccess(viewer, protectedDocument), /PASSWORD_REQUIRED/);
    const token = jwt.sign({ userId: viewer._id, documentId: document._id, version: 2 }, 'test-key', { audience: 'document-access', expiresIn: 60 });
    access.assertAccess(viewer, protectedDocument, token);
    assert.throws(() => access.assertAccess(outsider, protectedDocument, token), /denied/);
    assert.throws(() => access.assertAccess(viewer, { ...protectedDocument, securityVersion: 3 }, token), /PASSWORD_REQUIRED/);
    assert.throws(() => access.assertAccess(owner, { ...document, locked: true }, null, true), /locked/);
});

test('denied direct mutations, revisions, comments and indirect comment IDs never reach handlers', async () => {
    const access = fixture();
    for (const event of ['document:update', 'documentRevisions:get', 'documentComments:get', 'documentComment:reply']) {
        const socket = access.socket(outsider); let reached = false, result;
        access.protectDocumentSocket(socket).on(event, async () => { reached = true; });
        await socket.handlers[event]({ _id: document._id, documentId: document._id }, response => { result = response; });
        assert.equal(reached, false); assert.equal(result.status, 'error');
    }
});

test('notifications deliver no protected data to excluded or revoked recipients and strip secrets', async () => {
    const access = fixture();
    const yes = access.socket(viewer), no = access.socket(outsider), revoked = access.socket(owner); revoked.revoked = true;
    await access.protectedDocumentEmitter({ fetchSockets: async () => [yes, no, revoked] }).emit('document:updated', document);
    assert.equal(yes.received[0].event, 'document:updated');
    assert.equal(yes.received[0].payload.passwordHash, undefined);
    assert.equal(yes.received[0].payload.viewerIds, undefined);
    assert.deepEqual(no.received.map(item => item.event), ['document:accessChanged']);
    assert.equal(no.received[0].payload.title, undefined);
    assert.equal(revoked.received.length, 0);
});

test('password-protected library items expose no body or cover until unlocked', async () => {
    const access = fixture(), socket = access.socket(viewer);
    const result = await access.listDocument({ ...document, hasPassword: true, contentJson: { secret: 'body' }, thumbnail: { url: 'private' } }, viewer, socket);
    assert.equal(result.title, 'Private'); assert.equal(result.contentJson, undefined); assert.equal(result.thumbnail, undefined);
    assert.equal(await access.listDocument(document, outsider, access.socket(outsider)), null);
});

test('document settings wait for an in-flight collaborative message before applying', async () => {
    const access = fixture(), release = await access.acquireDocument(document._id);
    let acquired = false;
    const pending = access.acquireDocument(document._id).then(unlock => { acquired = true; unlock(); });
    await Promise.resolve(); assert.equal(acquired, false);
    release(); await pending; assert.equal(acquired, true);
});
