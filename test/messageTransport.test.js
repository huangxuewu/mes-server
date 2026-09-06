const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { Server } = require('socket.io');
const { io: connectClient } = require('../../client/node_modules/socket.io-client');
const { randomUUID } = require('node:crypto');
const { fixture } = require('./support/messageFixture');

test('real Socket.IO carries binary upload chunks and canonical sends over loopback', async t => {
    const state = fixture();
    const http = createServer();
    const io = new Server(http, { path: '/message-test', transports: ['websocket'] });
    state.io.sockets = io.sockets;
    io.on('connection', socket => {
        socket.data = { userId: state.ids.a, sessionGeneration: 1, expiresAt: Date.now() + 60000 };
        state.load('socket/event/message.js')(socket, io);
        state.load('socket/event/messageAttachment.js')(socket, io);
    });
    await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
    const client = connectClient(`http://127.0.0.1:${http.address().port}`, { path: '/message-test', transports: ['websocket'], forceNew: true });
    t.after(async () => { client.disconnect(); await new Promise(resolve => io.close(resolve)); });
    await new Promise((resolve, reject) => { client.once('connect', resolve); client.once('connect_error', reject); });
    const call = (event, payload) => new Promise((resolve, reject) => client.timeout(3000).emit(event, payload, (error, result) => {
        if (error) return reject(error);
        result.status === 'success' ? resolve(result.payload) : reject(new Error(result.message));
    }));
    const topicId = state.ids.topic;
    const bytes = Buffer.alloc(300000, 65);
    const stage = await call('messageAttachment:stage', { topicId, clientRequestId: randomUUID(), filename: 'shift.txt', mime: 'text/plain', size: bytes.length });
    let offset = 0;
    while (offset < bytes.length) {
        const next = await call('messageAttachment:chunk', { _id: stage._id, offset, contents: bytes.subarray(offset, offset + stage.chunkSize) });
        assert.ok(next.offset > offset);
        offset = next.offset;
    }
    assert.equal([...state.files.values()][0].length, bytes.length);
    const payload = { topicId, type: 'Text', content: 'Shift notes', attachments: [stage._id], clientRequestId: randomUUID() };
    const first = await call('message:create', payload);
    const retry = await call('message:create', payload);
    assert.equal(first._id, retry._id);
    assert.equal(first.attachments[0].url, undefined);
    const messages = await call('message:fetch', { topicId, limit: 50 });
    assert.equal(messages.items.length, 1);
    assert.equal(messages.items[0].content, 'Shift notes');
});
