const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const PDFDocument = require('pdfkit');
const sharp = require('sharp');

// Stub model imports before loading the real handler: no database or network use.
const models = require.resolve('../../models');
require.cache[models] = { id: models, filename: models, loaded: true, exports: {} };
const handlers = {};
require('../../socket/event/utility')({ on: (event, handler) => { handlers[event] = handler; } }, {});
const thumbnail = async input => {
    let reply;
    await handlers['pdf:thumbnail'](input, response => { reply = response; });
    return reply;
};
const hash = buffer => createHash('sha256').update(buffer).digest('hex');

(async () => {
    const pixels = Buffer.alloc(1200 * 1600 * 3);
    let seed = 12345;
    for (let i = 0; i < pixels.length; i++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        pixels[i] = seed >>> 24;
    }
    const jpeg = await sharp(pixels, { raw: { width: 1200, height: 1600, channels: 3 } }).jpeg({ quality: 75 }).toBuffer();
    const input = await new Promise(resolve => {
        const doc = new PDFDocument({ size: 'LETTER' }), chunks = [];
        doc.on('data', chunk => chunks.push(chunk));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.image(jpeg, 0, 0, { width: 612, height: 792 });
        // A second, different page verifies that only the first page is returned.
        doc.addPage().rect(0, 0, 612, 792).fill('red');
        doc.end();
    });
    const render = async payload => {
        const reply = await thumbnail(payload);
        assert.equal(reply.status, 'success', reply.message);
        assert.ok(Buffer.isBuffer(reply.payload));
        assert.equal(hash(reply.payload), '10ccb2d9bd22e4c4721674312196fd74958c82842dd8d99c1dd17d0b47ea0998');
    };
    await render(input);
    await delay(50);
    global.gc();
    const warm = process.memoryUsage();
    for (let i = 0; i < 30; i++) {
        await render(input);
        if (i % 10 === 9) { await delay(20); global.gc(); }
    }
    await delay(100);
    global.gc();
    const settled = process.memoryUsage();
    // Existing wire formats and concurrent document isolation remain supported.
    const padded = Buffer.concat([Buffer.from('prefix'), input, Buffer.from('suffix')]);
    await Promise.all([
        render(input.toString('base64')),
        render(`data:application/pdf;base64,${input.toString('base64')}`),
        render(new Uint8Array(padded.buffer, padded.byteOffset + 6, input.length)),
    ]);
    for (const payload of [null, {}, Buffer.alloc(0), Buffer.from('not a PDF')]) {
        const reply = await thumbnail(payload);
        assert.equal(reply.status, 'error');
        assert.ok(reply.message);
    }
    await render(input); // A failed request must not break subsequent documents.
    console.log(JSON.stringify({ renders: 30, arrayBufferGrowth: settled.arrayBuffers - warm.arrayBuffers,
        warmRss: warm.rss, settledRss: settled.rss, warmArrayBuffers: warm.arrayBuffers, settledArrayBuffers: settled.arrayBuffers }));
})().catch(error => { console.error(error); process.exitCode = 1; });
