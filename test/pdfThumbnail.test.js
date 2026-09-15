const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const test = require('node:test');

// Replace only the ESM boundary to exercise failure/cleanup ordering without a DB.
const fixture = pdf => {
    const source = fs.readFileSync(require.resolve('../socket/event/utility'), 'utf8');
    const boundary = 'await import("pdf-to-img")';
    assert.ok(source.includes(boundary));
    const module = { exports: {} }, handlers = {};
    vm.runInNewContext(source.replace(boundary, 'await loadPdf()'), {
        module, Buffer, ArrayBuffer, loadPdf: async () => ({ pdf }), require: () => ({}),
    });
    module.exports({ on: (event, handler) => { handlers[event] = handler; } }, {});
    return handlers['pdf:thumbnail'];
};

for (const outcome of ['success', 'render error', 'empty page']) {
    test(`thumbnail waits for destruction before replying: ${outcome}`, { timeout: 2000 }, async () => {
        let finishCleanup, cleanupStarted;
        const cleaning = new Promise(resolve => { cleanupStarted = resolve; });
        const cleanup = new Promise(resolve => { finishCleanup = resolve; });
        let destroys = 0, reply;
        const handler = fixture(async () => ({
            getPage: async page => {
                assert.equal(page, 1);
                if (outcome === 'render error') throw new Error('Render failed');
                return outcome === 'empty page' ? null : Buffer.from('PNG');
            },
            destroy: async () => { destroys++; cleanupStarted(); await cleanup; },
        }));
        const pending = handler(Buffer.from('PDF'), response => { reply = response; });
        await cleaning;
        assert.equal(reply, undefined);
        finishCleanup();
        await pending;
        assert.equal(destroys, 1);
        assert.equal(reply.status, outcome === 'success' ? 'success' : 'error');
        if (outcome === 'success') assert.equal(reply.payload.toString(), 'PNG');
        else assert.equal(reply.message, outcome === 'render error' ? 'Render failed' : 'Failed to render first page');
    });
}

test('load and cleanup failures return an error response', async () => {
    for (const stage of ['load', 'cleanup']) {
        const handler = fixture(async () => {
            if (stage === 'load') throw new Error('Load failed');
            return { getPage: async () => Buffer.from('PNG'), destroy: async () => { throw new Error('Cleanup failed'); } };
        });
        const replies = [];
        await handler(Buffer.from('PDF'), response => replies.push(response));
        assert.equal(replies.length, 1);
        assert.equal(replies[0].status, 'error');
        assert.match(replies[0].message, /failed/);
    }
});

test('real thumbnails preserve output and release decoded image buffers across repeated requests', { timeout: 120000 }, async t => {
    const { stdout } = await promisify(execFile)(process.execPath, [
        '--expose-gc', path.join(__dirname, 'support/pdfThumbnailMemory.cjs'),
    ], { timeout: 110000, maxBuffer: 1024 * 1024 });
    const result = JSON.parse(stdout.trim().split(/\r?\n/).at(-1));
    t.diagnostic(JSON.stringify(result));
    // The old renderer retains about 195 MiB for these 30 repetitions.
    // Buffer retention is the regression signal; RSS varies with OS allocators.
    assert.ok(result.arrayBufferGrowth < 32 * 1024 * 1024, `Retained ${result.arrayBufferGrowth} bytes`);
    assert.equal(result.renders, 30);
});
