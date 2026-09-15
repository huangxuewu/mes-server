const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const fs = require('node:fs');
const vm = require('node:vm');
const { performance } = require('node:perf_hooks');

// Synthetic documents only. The optional source path benchmarks a saved baseline.
const filename = require.resolve('../../utils/documentResources');
const moduleUnderTest = { exports: {} };
vm.runInNewContext(fs.readFileSync(process.argv[2] || filename, 'utf8'), {
    require: createRequire(filename), module: moduleUnderTest, URL, Date, Map, Set, Uint8Array,
});
const asset = { _id: 'asset', purpose: 'resource', url: 'https://example.test/unused.png',
    storagePath: '/DH MES/document/owner/assets/unused.png' };
const owner = { _id: 'owner', attachments: [asset] };
const count = 5000;
const makeRecord = index => ({ _id: `doc-${index}`, contentJson: { paragraphs: Array.from({ length: 10 }, (_, paragraph) =>
    // Force separate flat strings rather than shared ropes in this synthetic corpus.
    Buffer.from(`${index}:${paragraph}:` + 'x'.repeat(1024)).toString()) } });
let cursorReads = 0, materializedReads = 0, closed = 0, measured;
const query = revision => ({ select() { return this; }, lean() { return this; },
    then(resolve, reject) {
        materializedReads++;
        return Promise.resolve(revision ? [] : [owner, ...Array.from({ length: count }, (_, index) => makeRecord(index))]).then(resolve, reject);
    },
    cursor() {
        cursorReads++;
        return { async *[Symbol.asyncIterator]() {
            if (revision) return;
            yield owner;
            for (let index = 0; index < count; index++) yield makeRecord(index);
        }, async close() { closed++; } };
    },
});
const db = {
    document: { find: () => query(false), findById: () => ({ select: () => ({ lean: async () => owner }) }),
        exists: async () => false, updateOne: async () => {} },
    documentRevision: { find: () => query(true), exists: async () => false },
};
global.gc();
const before = process.memoryUsage(), start = performance.now();
moduleUnderTest.exports.cleanupDocumentResources({ documentId: 'owner', resourceIds: ['asset'], db,
    dropbox: { filesGetMetadata: async () => {
        global.gc(); measured = process.memoryUsage();
        return { result: { '.tag': 'file' } };
    }, filesDeleteV2: async () => {} },
}).then(() => {
    assert.ok(measured, 'unused synthetic resource reaches the deletion check');
    console.log(JSON.stringify({ documents: count, elapsedMs: Math.round(performance.now() - start),
        heapGrowthMiB: +( (measured.heapUsed - before.heapUsed) / 1048576).toFixed(2),
        rssAtDeletionMiB: +(measured.rss / 1048576).toFixed(2), cursorReads, materializedReads, closed }));
}).catch(error => { console.error(error); process.exitCode = 1; });
