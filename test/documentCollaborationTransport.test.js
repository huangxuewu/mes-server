const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { once } = require("node:events");
const jwt = require("jsonwebtoken");
const Y = require("yjs");
const WebSocket = require("ws");
const encoding = require("lib0/encoding");
const sync = require("y-protocols/sync");
const { writeAuthentication } = require("@hocuspocus/common");
const { MessageType } = require("@hocuspocus/server");

test("real WebSocket edits survive a failed settings save and are persisted before a successful lock closes the client", { timeout: 10000 }, async (t) => {
    const documentId = "aaaaaaaaaaaaaaaaaaaaaaaa", userId = "bbbbbbbbbbbbbbbbbbbbbbbb";
    let stored, storedBy, loads = 0, failSettings = true;
    const record = { _id: documentId, status: 'Draft' };
    const db = {
        user: { findById: () => ({ lean: async () => ({ _id: userId, role: "System", status: 'Active' }) }) },
        document: {
            findOne: () => ({ lean: async () => record }),
            findById: () => ({ lean: async () => record, select: async () => { loads++; return { ...record, yjsState: stored }; } }),
            findOneAndUpdate: async (filter, update) => {
                if (failSettings) throw new Error('Temporary database outage');
                Object.assign(record, update.$set);
                stored = Buffer.from(update.$set.yjsState);
                return record;
            },
            updateOne: async (filter, update) => {
                stored = Buffer.from(update.$set.yjsState);
                storedBy = update.$set.updatedBy;
            },
        },
    };
    const context = { module: { exports: {} }, Buffer, URL, Request, console, require: (name) => {
        if (name === "../models") return db;
        if (name === "./session") return { JWT_SECRET: "transport-test-secret", hasPermission: () => false, isBoundDocumentSession: () => true, sessionSignature: require('../socket/session').sessionSignature };
        return require(name);
    } };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../socket/collaboration.js"), "utf8"), context);
    const { attachCollaboration, collaboration } = context.module.exports;
    const server = http.createServer(), sockets = new Set();
    server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
    attachCollaboration(server);
    const clients = [];
    t.after(async () => {
        clients.forEach((client) => client.terminate());
        collaboration.closeConnections();
        collaboration.flushPendingStores();
        sockets.forEach((socket) => socket.destroy());
        await new Promise((resolve) => server.close(resolve));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const client = new WebSocket(`ws://127.0.0.1:${server.address().port}/collaboration`);
    clients.push(client);
    await once(client, "open");
    const frame = (type, write) => {
        const encoder = encoding.createEncoder();
        encoding.writeVarString(encoder, documentId);
        encoding.writeVarUint(encoder, type);
        write(encoder);
        client.send(encoding.toUint8Array(encoder));
    };
    frame(MessageType.Auth, (encoder) => writeAuthentication(encoder, jwt.sign({ userId }, "transport-test-secret")));
    const source = new Y.Doc();
    source.getText("transport-test").insert(0, "A real WebSocket edit");
    t.after(() => source.destroy());
    frame(MessageType.Sync, (encoder) => sync.writeUpdate(encoder, Y.encodeStateAsUpdate(source)));
    const until = async (predicate, message) => {
        const deadline = Date.now() + 5000;
        while (!predicate()) {
            assert.ok(Date.now() < deadline, message);
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
    };
    await until(() => stored, "Binary messages must reach authentication, document loading and persistence");
    const restored = new Y.Doc();
    t.after(() => restored.destroy());
    Y.applyUpdate(restored, stored);
    assert.equal(restored.getText("transport-test").toString(), "A real WebSocket edit");
    assert.equal(storedBy, userId);
    assert.equal(loads, 1);
    assert.equal(collaboration.documents.size, 1);
    const live = collaboration.documents.get(documentId);
    source.getText('transport-test').insert(0, 'Latest edits ');
    frame(MessageType.Sync, encoder => sync.writeUpdate(encoder, Y.encodeStateAsUpdate(source)));
    await until(() => live.getText('transport-test').toString().startsWith('Latest edits'), 'The latest edit reaches the live document');
    const handlers = {};
    const rawSocket = { id: 'settings-socket', data: { userId, sessionGeneration: 1, expiresAt: Date.now() + 60000 }, on: (event, handler) => { handlers[event] = handler; } };
    const settingsModule = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../socket/event/documentSettings.js'), 'utf8'), {
        module: settingsModule, Buffer, console, require: name => {
            if (name === '../../models') return db;
            if (name === '../session') return { getActiveSessionUser: async () => ({ _id: userId, role: 'System', status: 'Active' }) };
            if (name === '../collaboration') return context.module.exports;
            if (name === '../../utils/documentAccess') return require('../utils/documentAccess');
            return require(name);
        },
    });
    settingsModule.exports(rawSocket, { fetchSockets: async () => [] });
    const changeSettings = async () => {
        let result;
        await handlers['documentSettings:update']({ documentId, expectedVersion: 0,
            settings: { locked: true, visibility: 'everyone', viewerIds: [], watermark: '', watermarkLayout: 'single' },
        }, response => { result = response; });
        return result;
    };
    const failed = await changeSettings();
    assert.equal(failed.status, 'error');
    assert.equal(collaboration.documents.get(documentId), live);
    assert.equal(live.getConnectionsCount(), 1);
    assert.equal(live.fileSettingsPending, false);
    collaboration.flushPendingStores();
    const storedText = () => { const copy = new Y.Doc(); Y.applyUpdate(copy, stored); const text = copy.getText('transport-test').toString(); copy.destroy(); return text; };
    await until(() => storedText().startsWith('Latest edits'), 'Stores still persist the live edits after a failed settings write');
    source.getText('transport-test').insert(0, 'Before successful lock ');
    frame(MessageType.Sync, encoder => sync.writeUpdate(encoder, Y.encodeStateAsUpdate(source)));
    await until(() => live.getText('transport-test').toString().startsWith('Before successful lock'), 'Editing still works after rollback');
    failSettings = false;
    const saved = await changeSettings();
    assert.equal(saved.status, 'success', saved.message);
    assert.equal(record.locked, true);
    assert.equal(storedText(), source.getText('transport-test').toString());
    const authorizedState = Buffer.from(stored);
    source.getText('transport-test').insert(0, 'Blocked edit ');
    frame(MessageType.Sync, encoder => sync.writeUpdate(encoder, Y.encodeStateAsUpdate(source)));
    await until(() => collaboration.documents.size === 0, 'Revoked client must release its document connection');
    assert.deepEqual(stored, authorizedState);
    if (client.readyState !== WebSocket.CLOSED) { const closed = once(client, 'close'); client.close(); await closed; }
    await until(() => collaboration.documents.size === 0, "Closing the socket must release its Hocuspocus document");
});
