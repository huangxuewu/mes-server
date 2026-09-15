const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const express = require('express');
const { once } = require('node:events');
const { Decoder, Encoder, PacketType } = require('socket.io-parser');

test('HTTP views still render login, authenticated dashboard and escaped errors', async () => {
    const app = express();
    app.set('views', path.join(__dirname, '../views'));
    app.set('view engine', 'pug');
    app.use(express.json({ limit: '1kb' }));
    app.use(express.urlencoded({ extended: true, limit: '1kb' }));
    app.get('/', (_req, res) => res.render('index', { title: 'MES System' }));
    app.get('/dashboard', (_req, res) => res.render('index', {
        title: 'MES System', isAuthenticated: true, user: { username: '<script>operator</script>' },
    }));
    app.get('/login', (_req, res) => res.render('login', { error: '<img src=x onerror=alert(1)>' }));
    app.get('/error', (_req, res) => res.status(500).render('error', {
        message: '<script>failure</script>', error: { status: 500, stack: '<script>stack</script>' },
    }));
    app.post('/echo', (req, res) => res.json(req.body));
    app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));
    const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    const url = `http://127.0.0.1:${server.address().port}`;
    try {
        const root = await fetch(url); assert.equal(root.status, 200);
        assert.match(await root.text(), /Login Required/);
        const dashboard = await (await fetch(`${url}/dashboard`)).text();
        assert.match(dashboard, /Inventory Management/);
        assert.match(dashboard, /&lt;script&gt;operator&lt;\/script&gt;/);
        const login = await (await fetch(`${url}/login`)).text();
        assert.match(login, /action="\/api\/login" method="POST"/);
        assert.match(login, /&lt;img src=x onerror=alert\(1\)&gt;/);
        const error = await fetch(`${url}/error`); assert.equal(error.status, 500);
        const errorHtml = await error.text();
        assert.match(errorHtml, /&lt;script&gt;failure&lt;\/script&gt;/);
        assert.doesNotMatch(errorHtml, /<script>/);
        const post = body => fetch(`${url}/echo`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
        assert.deepEqual(await (await post('user[name]=operator&list[]=one&list[]=two')).json(), { user: { name: 'operator' }, list: ['one', 'two'] });
        assert.equal((await post('value=' + 'x'.repeat(2048))).status, 413);
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('Socket.IO rejects zero or excessive binary attachments and accepts a nine-image station reply', () => {
    for (const count of [0, 11, 1000000]) {
        const decoder = new Decoder();
        assert.throws(() => decoder.add(`5${count}-["capture"]`), /attachments/i);
        decoder.destroy();
    }
    const decoder = new Decoder(), encoder = new Encoder();
    let received;
    decoder.on('decoded', packet => { received = packet; });
    const contents = Array.from({ length: 9 }, (_, index) => Buffer.from(`image-${index}`));
    for (const packet of encoder.encode({ type: PacketType.EVENT, nsp: '/', data: ['capture', contents] })) decoder.add(packet);
    assert.deepEqual(received.data, ['capture', contents]);
    assert.throws(() => decoder.add(Buffer.from('unexpected')), /not reconstructing/);
    decoder.destroy();
});
