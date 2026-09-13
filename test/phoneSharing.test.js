const test = require('node:test');
const assert = require('node:assert/strict');
const { createPhoneSharing, IDLE_MS, MAX_MS } = require('../socket/phoneSharing');
const fixture = options => {
    let time = 1000000;
    const messages = [], owners = new Map(), publications = [];
    const socket = id => ({ id, data: {}, connected: true, emit: (event, data) => messages.push({ id, event, data }), disconnect() { this.connected = false; } });
    const desktop = socket('desktop');
    const owner = { socket: desktop, device: 'Office PC', user: { _id: 'alice', displayName: 'Alice' } };
    owners.set(desktop.id, owner);
    const phone = createPhoneSharing({ getOwner: id => owners.get(id), active: owner => !!owner?.socket.connected,
        publish: socket => publications.push(socket.id), now: () => time, db: { config: { find: () => ({ maxTimeMS: () => ({ lean: async () => [] }) }), findOne: () => ({ maxTimeMS: () => ({ lean: async () => ({ value: options && 'value' in options ? options.value : 'https://mes.example/sharing' }) }) }) } }, renderQr: async () => 'data:image/png;base64,test', ...options });
    const create = () => phone.create(desktop);
    const claim = (link, name = 'phone', key = 'a'.repeat(64)) => {
        const guest = socket(name); phone.claim(guest, { invite: new URL(link.url).hash.slice(1), key }); phone.connected(guest); return guest;
    };
    return { phone, desktop, owner, owners, socket, messages, publications, create, claim, advance: ms => { time += ms; } };
};

test('creation requires active sharing and configured HTTPS; reopening reuses the QR including concurrent creation', async () => {
    const env = fixture();
    await assert.rejects(env.phone.create(env.socket('outsider')), /phoneUnavailable/);
    const links = await Promise.all([env.create(), env.create()]);
    assert.deepEqual(links[0], links[1]);
    assert.match(links[0].url, /^https:\/\/mes.example\/sharing#[a-f0-9]{64}$/);
    assert.equal(links[0].idleExpiresAt - links[0].createdAt, IDLE_MS);
    assert.equal(links[0].expiresAt - links[0].createdAt, MAX_MS);
    for (const url of [undefined, 'http://localhost/sharing', 'https://a.example/', 'https://user:pass@a.example/sharing']) {
        await assert.rejects(fixture({ value: url }).create(), /phoneConfiguration/);
    }
});

test('a QR pairs once; only the same page credential can reconnect before expiry', async () => {
    const env = fixture(), link = await env.create(), guest = env.claim(link);
    assert.throws(() => env.claim(link, 'second', 'b'.repeat(64)), /phoneExpired/);
    assert.throws(() => env.claim(link, 'duplicate'), /phoneInUse/);
    assert.equal(env.phone.peer(env.desktop).id, link.peerId);
    assert.equal(env.phone.peer(env.socket('other')), null);
    guest.connected = false; env.phone.disconnected(guest);
    assert.equal(env.phone.peer(env.desktop), null);
    const resumed = env.socket('resumed'); env.phone.claim(resumed, { id: link.id, key: 'a'.repeat(64) }); env.phone.connected(resumed);
    assert.equal(env.phone.peer(env.desktop).id, link.peerId);
    assert.throws(() => env.phone.claim(env.socket('attacker'), { id: link.id, key: 'b'.repeat(64) }), /phoneExpired/);
});

test('cancellation during QR rendering cannot return a live link; render failures release the invitation', async () => {
    let rendered;
    const env = fixture({ renderQr: () => new Promise(resolve => { rendered = resolve; }) });
    const first = env.create(), reopened = env.create();
    await new Promise(resolve => setImmediate(resolve)); env.phone.remove(env.desktop.id); rendered('image');
    const results = await Promise.allSettled([first, reopened]);
    assert.ok(results.every(result => result.status === 'rejected' && result.reason.message === 'phoneExpired'));
    let fail = true;
    const recovery = fixture({ renderQr: () => { if (fail) throw new Error('render failed'); return 'image'; } });
    await assert.rejects(recovery.create(), /phoneUnavailable/);
    fail = false; assert.equal((await recovery.create()).qr, 'image');
});

test('creator cancellation revokes paired and unclaimed invitations, rejects others, and permits a new QR', async () => {
    const env = fixture(), first = await env.create();
    assert.throws(() => env.phone.cancel(env.socket('other'), { id: first.id }), /phoneUnauthorized/);
    env.phone.cancel(env.desktop, { id: first.id });
    assert.throws(() => env.claim(first), /phoneExpired/);
    const second = await env.create(), guest = env.claim(second);
    assert.notEqual(second.url, first.url);
    env.phone.cancel(env.desktop, { id: second.id });
    assert.equal(guest.connected, false);
    assert.equal(env.messages.filter(message => message.event === 'phone:state').at(-1).data.status, 'cancelled');
    assert.throws(() => env.phone.signalPhone(guest, { to: env.desktop.id, type: 'request', data: {} }), /phoneExpired/);
});

test('phone signaling is limited to its desktop; unsolicited peers and oversized signals are rejected', async () => {
    const env = fixture(), link = await env.create(), guest = env.claim(link);
    env.phone.signalPhone(guest, { to: env.desktop.id, type: 'request', data: {} });
    assert.equal(env.messages.at(-1).data.from, link.peerId);
    env.phone.signalDesktop(env.desktop, { to: link.peerId, type: 'offer', data: {} });
    assert.equal(env.messages.at(-1).id, guest.id);
    assert.throws(() => env.phone.signalPhone(guest, { to: 'someone-else', type: 'request' }), /phoneUnauthorized/);
    assert.throws(() => env.phone.signalDesktop(env.desktop, { to: 'phone:other', type: 'offer' }), /phoneUnavailable/);
    assert.throws(() => env.phone.signalPhone(guest, { to: env.desktop.id, type: 'file', data: {} }), /Invalid signal/);
    assert.throws(() => env.phone.signalPhone(guest, { to: env.desktop.id, type: 'offer', data: 'x'.repeat(65536) }), /Invalid signal/);
});

test('unclaimed and paired idle deadlines are enforced exactly; reconnecting and signaling do not extend them', async () => {
    const env = fixture(), first = await env.create();
    env.advance(IDLE_MS); assert.throws(() => env.claim(first), /phoneExpired/);
    const link = await env.create(), guest = env.claim(link);
    env.advance(IDLE_MS - 1); env.phone.signalPhone(guest, { to: env.desktop.id, type: 'request' });
    guest.connected = false; env.phone.disconnected(guest); env.claim(link, 'resumed');
    env.advance(1); env.phone.sweep();
    assert.equal(env.messages.filter(message => message.event === 'sharing:phone').at(-1).data.status, 'expired');
    assert.throws(() => env.claim(link), /phoneExpired/);
});

test('interaction and desktop write progress extend idle time but never the absolute 24-hour deadline', async () => {
    const env = fixture(), link = await env.create(), guest = env.claim(link);
    env.advance(IDLE_MS - 1); env.phone.activity(guest);
    env.advance(IDLE_MS - 1); env.phone.progress(env.desktop, { id: link.id });
    assert.throws(() => env.phone.progress(env.socket('other'), { id: link.id }), /phoneUnauthorized/);
    let elapsed = (IDLE_MS - 1) * 2;
    while (elapsed + IDLE_MS - 1 < MAX_MS) { env.advance(IDLE_MS - 1); elapsed += IDLE_MS - 1; env.phone.progress(env.desktop, { id: link.id }); }
    env.advance(MAX_MS - elapsed); env.phone.sweep();
    assert.equal(guest.connected, false);
    assert.throws(() => env.phone.activity(guest), /phoneExpired/);
});

test('page exit credentials, desktop removal, session replacement, and server restart invalidate access', async () => {
    const env = fixture(), link = await env.create(), guest = env.claim(link);
    for (const key of ['b'.repeat(64), 'é'.repeat(64), null]) env.phone.leave({ id: link.id, key });
    env.phone.leave(null); assert.equal(guest.connected, true);
    env.phone.leave({ id: link.id, key: 'a'.repeat(64) }); assert.equal(guest.connected, false);
    const second = await env.create(); env.phone.remove(env.desktop.id); assert.throws(() => env.claim(second), /phoneExpired/);
    const third = await env.create(); env.owners.set(env.desktop.id, { ...env.owner }); env.phone.sweep(); assert.throws(() => env.claim(third), /phoneExpired/);
    assert.throws(() => fixture().claim(link), /phoneExpired/);
});

test('the mobile HTTP endpoint serves local assets without claiming a QR and accepts only credentialed termination', async t => {
    const express = require('express'), app = express();
    const env = fixture(), link = await env.create();
    app.use('/sharing', require('../routes/sharing')(env.phone));
    const server = await new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const page = await fetch(`${origin}/sharing/`);
    assert.equal(page.status, 200); assert.equal(page.headers.get('cache-control'), 'no-store');
    assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
    assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    const html = await page.text(); assert.match(html, /Upload image/); assert.match(html, /Upload file/); assert.doesNotMatch(html, /appToken|MASTERWU/);
    for (const file of ['phone.mjs', 'transfer.mjs', 'labels.mjs', 'phone.css']) assert.equal((await fetch(`${origin}/sharing/${file}`)).status, 200);
    const guest = env.claim(link);
    const end = key => fetch(`${origin}/sharing/end`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: link.id, key }) });
    assert.equal((await end('b'.repeat(64))).status, 204); assert.equal(guest.connected, true);
    assert.equal((await end('a'.repeat(64))).status, 204); assert.equal(guest.connected, false);
});
