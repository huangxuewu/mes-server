const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const finishProductLabelRouter = require('./finishProductLabel');

async function withServer(run) {
    const app = express();
    app.use('/addon/labelMaker/finishProduct', finishProductLabelRouter);
    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    try {
        const { port } = server.address();
        await run(`http://127.0.0.1:${port}`);
    } finally {
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
}

test('serves the finished-product label maker at the exact endpoint', async () => {
    await withServer(async (origin) => {
        const response = await fetch(`${origin}/addon/labelMaker/finishProduct`);
        const html = await response.text();
        assert.equal(response.status, 200);
        assert.match(response.headers.get('content-type'), /text\/html/);
        assert.match(html, /id="print-button"/);
        assert.match(html, /Finished Product/);
        assert.match(html, /RW403B/);
    });
});

test('serves the label-maker assets beneath the endpoint', async () => {
    await withServer(async (origin) => {
        const [script, stylesheet, compressor, config] = await Promise.all([
            fetch(`${origin}/addon/labelMaker/finishProduct/assets/app.js`),
            fetch(`${origin}/addon/labelMaker/finishProduct/assets/styles.css`),
            fetch(`${origin}/addon/labelMaker/finishProduct/assets/heatshrink.js`),
            fetch(`${origin}/addon/labelMaker/finishProduct/assets/config.js`),
        ]);
        assert.equal(script.status, 200);
        assert.equal(stylesheet.status, 200);
        assert.equal(compressor.status, 200);
        assert.equal(config.status, 200);
        assert.match(await config.text(), /"socketPath":"\/socket"/);
    });
});
