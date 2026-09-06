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

test("the HTTP upgrade integration authenticates binary edits, persists them, and releases closed connections", { timeout: 10000 }, async (t) => {
    const documentId = "aaaaaaaaaaaaaaaaaaaaaaaa", userId = "bbbbbbbbbbbbbbbbbbbbbbbb";
    let stored, storedBy, loads = 0;
    const db = {
        user: { findById: () => ({ lean: async () => ({ _id: userId, role: "System" }) }) },
        document: {
            findOne: () => ({ lean: async () => ({ _id: documentId, status: "Draft" }) }),
            findById: () => ({ select: async () => { loads++; return { yjsState: stored }; } }),
            updateOne: async (filter, update) => {
                stored = Buffer.from(update.$set.yjsState);
                storedBy = update.$set.updatedBy;
            },
        },
    };
    const context = { module: { exports: {} }, Buffer, URL, Request, console, require: (name) => {
        if (name === "../models") return db;
        if (name === "./session") return { JWT_SECRET: "transport-test-secret", hasPermission: () => false };
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
    const closed = once(client, "close");
    client.close();
    await closed;
    await until(() => collaboration.documents.size === 0, "Closing the socket must release its Hocuspocus document");
});
