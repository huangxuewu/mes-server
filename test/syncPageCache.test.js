const test = require('node:test');
const assert = require('node:assert/strict');
const { createSyncPageCache } = require('../utils/syncPageCache');
const tick = () => new Promise(resolve => setImmediate(resolve));

test('25 cold requests and a late retry share one build and the same retained page', async () => {
    const cache = createSyncPageCache();
    let release, builds = 0;
    const held = new Promise(resolve => { release = resolve; });
    const build = async () => { builds++; await held; return { upserts: [{ name: 'shared' }] }; };
    const requests = Array.from({ length: 25 }, () => cache.read('orders:version1', build));
    await tick();
    const retry = cache.read('orders:version1', build);
    assert.equal(builds, 1); assert.equal(cache.stats().joins, 25);
    release(); const pages = await Promise.all([...requests, retry]);
    assert.ok(pages.every(page => page === pages[0]));
    assert.equal(await cache.read('orders:version1', build), pages[0]);
    assert.equal(builds, 1);
});

test('different pages are bounded, overload fails promptly, and failures can retry', async () => {
    const cache = createSyncPageCache({ concurrency: 2, maxPending: 3 });
    let release;
    const held = new Promise(resolve => { release = resolve; });
    const build = () => held.then(() => ({ ok: true }));
    const requests = ['a', 'b', 'c'].map(key => cache.read(key, build));
    await tick();
    assert.equal(cache.stats().active, 2); assert.equal(cache.stats().builds, 2);
    await assert.rejects(cache.read('d', build), { code: 'UNAVAILABLE' });
    release(); await Promise.all(requests); await tick();
    await assert.rejects(cache.read('failure', async () => { throw new Error('read failed'); }), /read failed/);
    await tick();
    assert.deepEqual(await cache.read('failure', async () => ({ recovered: true })), { recovered: true });
});

test('encoded bytes, entry count, LRU eviction and expiry bound retained pages', async () => {
    let now = 0;
    const cache = createSyncPageCache({ maxBytes: 50, maxEntries: 2, ttlMs: 100, now: () => now });
    let builds = 0;
    const build = async () => { builds++; return 'x'.repeat(20); };
    await cache.read('a', build); await cache.read('b', build); await cache.read('a', build);
    await cache.read('c', build);
    assert.equal(cache.stats().entries, 2); assert.equal(cache.stats().encodedBytes, 44);
    await cache.read('b', build); assert.equal(builds, 4);
    now = 101; await cache.read('b', build); assert.equal(builds, 5);
    await cache.read('large', async () => 'z'.repeat(100));
    assert.ok(cache.stats().encodedBytes <= 50);
    cache.clear(); assert.equal(cache.stats().encodedBytes, 0);
});
