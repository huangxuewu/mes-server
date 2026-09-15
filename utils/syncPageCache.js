// One shared page/build per version and request shape, across all sockets in this process.
// Limits are encoded-byte budgets, not a claim about V8 or total process memory.
function createSyncPageCache({ maxBytes = 16 * 1024 * 1024, maxEntries = 128, concurrency = 2,
    maxPending = 64, ttlMs = Infinity, now = Date.now } = {}) {
    const ready = new Map(), pending = new Map(), queue = [];
    let bytes = 0, active = 0, builds = 0, hits = 0, joins = 0;
    const remove = key => { const entry = ready.get(key); if (entry) { bytes -= entry.bytes; ready.delete(key); } };
    const drain = () => {
        while (active < concurrency && queue.length) {
            const job = queue.shift(); active++; builds++;
            Promise.resolve().then(job.build).then(value => {
                const size = Buffer.byteLength(JSON.stringify(value));
                if (size <= maxBytes && maxEntries > 0) {
                    for (const [key, entry] of ready) if (entry.expires <= now()) remove(key);
                    while (ready.size && (bytes + size > maxBytes || ready.size >= maxEntries)) remove(ready.keys().next().value);
                    ready.set(job.key, { value, bytes: size, expires: now() + ttlMs }); bytes += size;
                }
                return value;
            }).then(value => {
                pending.delete(job.key); active--; drain(); job.resolve(value);
            }, error => {
                pending.delete(job.key); active--; drain(); job.reject(error);
            });
        }
    };
    return {
        read(key, build) {
            const entry = ready.get(key);
            if (entry && entry.expires > now()) {
                hits++; ready.delete(key); ready.set(key, entry); return Promise.resolve(entry.value);
            }
            remove(key);
            if (pending.has(key)) { joins++; return pending.get(key); }
            if (pending.size >= maxPending) return Promise.reject(Object.assign(new Error('Sync preparation is busy; retry shortly'), { code: 'UNAVAILABLE' }));
            let resolve, reject;
            const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
            pending.set(key, promise); queue.push({ key, build, resolve, reject }); drain();
            return promise;
        },
        clear() { ready.clear(); bytes = 0; },
        stats() { return { entries: ready.size, encodedBytes: bytes, active, pending: pending.size, builds, hits, joins }; },
    };
}

module.exports = { createSyncPageCache };
