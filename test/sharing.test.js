const test = require('node:test');
const assert = require('node:assert/strict');
const { createSharing } = require('../socket/sharing');

const fixture = options => {
    let time = 100000;
    const messages = [];
    const socket = (id, userId = id) => ({ id, connected: true, user: { _id: userId, displayName: userId, password: 'private' },
        data: { sessionGeneration: 1, expiresAt: 999999 }, emit: (event, data) => messages.push({ id, event, data }) });
    const service = createSharing({ io: {}, now: () => time, authorize: async socket => { if (!socket.user) throw new Error('unauthenticated'); return socket.user; },
        locatePeer: async () => ({ key: 'city', label: 'City, State' }), ...options });
    return { service, socket, messages, advance: ms => { time += ms; } };
};
test('presence uses session identities, projects safe profiles and keeps multiple devices distinct', async () => {
    const env = fixture(), first = env.socket('a', 'Alice'), second = env.socket('b', 'Alice');
    const one = await env.service.register(first, { device: 'Laptop', userId: 'Mallory' });
    await env.service.register(second, { device: 'Desktop' });
    const peers = env.service.snapshot();
    assert.equal(peers.length, 2); assert.equal(peers[0].userId, 'Alice'); assert.equal(peers[1].device, 'Desktop');
    assert.equal(peers[0].region.key, 'city'); assert.ok(!JSON.stringify(peers).includes(one.token));
    assert.ok(!JSON.stringify(peers).includes('private'));
    const anonymous = env.socket('anonymous'); anonymous.user = null;
    await assert.rejects(env.service.register(anonymous), /unauthenticated/);
});
test('LAN groups require mutual discovery, expire with observations, and reject invented tokens', async () => {
    const env = fixture(), a = env.socket('a'), b = env.socket('b'), c = env.socket('c');
    const pa = await env.service.register(a), pb = await env.service.register(b); await env.service.register(c);
    env.service.observe(a, { tokens: [pb.token] });
    assert.notEqual(env.service.snapshot()[0].network, env.service.snapshot()[1].network);
    env.service.observe(b, { tokens: [pa.token] });
    let list = env.service.snapshot(); assert.equal(list[0].network, list[1].network); assert.notEqual(list[1].network, list[2].network);
    env.service.observe(a, { tokens: [] }); list = env.service.snapshot(); assert.notEqual(list[0].network, list[1].network);
    assert.throws(() => env.service.observe(a, { tokens: ['not-a-token'] }), /Invalid discovery/);
});
test('signals go only to registered current peers; expiry, logout, oversized content and self-targets are rejected', async () => {
    const env = fixture(), a = env.socket('a'), b = env.socket('b');
    await env.service.register(a); await env.service.register(b);
    env.service.signal(a, { to: 'b', type: 'offer', data: { description: 'test' } });
    assert.equal(env.messages.at(-1).id, 'b'); assert.equal(env.messages.at(-1).data.from, 'a');
    assert.throws(() => env.service.signal(a, { to: 'a', type: 'offer' }), /Peer unavailable/);
    assert.throws(() => env.service.signal(a, { to: 'b', type: 'offer', data: 'x'.repeat(65536) }), /Invalid signal/);
    b.data.sessionGeneration++;
    assert.throws(() => env.service.signal(a, { to: 'b', type: 'offer' }), /Peer unavailable/);
    env.service.sweep(); assert.equal(env.service.snapshot().length, 1);
    env.advance(46000); env.service.sweep(); assert.equal(env.service.snapshot().length, 0);
});
test('late location lookups cannot restore presence after a session replacement', async () => {
    let resolve;
    const env = fixture({ locatePeer: () => new Promise(done => { resolve = done; }) }), a = env.socket('a');
    const pending = env.service.register(a); await new Promise(done => setImmediate(done));
    a.data.sessionGeneration++; resolve(null);
    await assert.rejects(pending, /Session changed/); assert.equal(env.service.snapshot().length, 0);
});
test('discovery tokens rotate without breaking recently observed neighbors', async () => {
    const env = fixture(), a = env.socket('a'), b = env.socket('b');
    const old = await env.service.register(a); await env.service.register(b);
    env.advance(61000);
    const fresh = await env.service.register(a); await env.service.register(b);
    assert.notEqual(old.token, fresh.token);
    env.service.observe(b, { tokens: [old.token] });
    env.service.remove('a'); assert.equal(env.service.snapshot().length, 1);
});

test('unchanged heartbeats and discovery do not broadcast duplicate presence', async () => {
    const env = fixture(), a = env.socket('a'), b = env.socket('b');
    const pa = await env.service.register(a), pb = await env.service.register(b);
    env.service.observe(a, { tokens: [pb.token] });
    env.service.observe(b, { tokens: [pa.token] });
    const count = env.messages.length;
    env.advance(5000);
    await env.service.register(a);
    env.service.observe(a, { tokens: [pb.token] });
    env.service.observe(b, { tokens: [pa.token] });
    assert.equal(env.messages.length, count);
    env.service.observe(a, { tokens: [] });
    assert.equal(env.messages.length, count + 2, 'a real network change still reaches both peers');
    env.service.remove('b');
    assert.equal(env.messages.at(-1).data.length, 1);
});

test('mutual discovery preserves transitive groups and splits after observations expire', async () => {
    const env = fixture(), sockets = ['a', 'b', 'c', 'd'].map(id => env.socket(id));
    const peers = [];
    for (const socket of sockets) peers.push(await env.service.register(socket));
    env.service.observe(sockets[0], { tokens: [peers[1].token] });
    env.service.observe(sockets[1], { tokens: [peers[0].token, peers[2].token] });
    env.service.observe(sockets[2], { tokens: [peers[1].token] });
    const list = env.service.snapshot();
    assert.equal(new Set(list.slice(0, 3).map(peer => peer.network)).size, 1);
    assert.notEqual(list[2].network, list[3].network);
    env.advance(21000);
    assert.equal(new Set(env.service.snapshot().map(peer => peer.network)).size, 4);
});
