const fields = ['rss', 'heapUsed', 'external', 'arrayBuffers'];
const mib = values => Object.fromEntries(fields.map(key => [key, Math.round(values[key] / 1048576 * 100) / 100]));

function createMemoryDiagnostics({ enabled = false, usage = process.memoryUsage, now = Date.now,
    log = line => console.log(line), maxLabels = 256 } = {}) {
    const rows = new Map();
    let timer, active = 0, sequence = 0, details = 0, suppressed = 0;
    const emit = record => {
        try { log('[Memory] ' + JSON.stringify({ timestamp: new Date(now()).toISOString(), pid: process.pid,
            dyno: process.env.DYNO || null, ...record })); } catch { /* Diagnostics must not fail business operations. */ }
    };
    const begin = label => {
        if (!enabled) return () => {};
        if (!/^[a-zA-Z0-9:._/-]{1,100}$/.test(label) || (!rows.has(label) && rows.size >= maxLabels)) label = 'other';
        if (!rows.has(label)) rows.set(label, { label, active: 0, completed: 0, errors: 0, overlaps: 0,
            maxActive: 0, maxDurationMs: 0, maxDelta: Object.fromEntries(fields.map(key => [key, 0])) });
        const row = rows.get(label), before = usage(), started = now(), id = ++sequence;
        const activeAtStart = active++;
        row.active++;
        row.maxActive = Math.max(row.maxActive, row.active);
        let ended = false;
        return failed => {
            if (ended) return;
            ended = true;
            const after = usage(), durationMs = now() - started;
            const delta = Object.fromEntries(fields.map(key => [key, after[key] - before[key]]));
            const overlap = activeAtStart > 0 || sequence !== id;
            active--; row.active--; row.completed++; row.errors += Boolean(failed); row.overlaps += overlap;
            row.maxDurationMs = Math.max(row.maxDurationMs, durationMs);
            for (const key of fields) row.maxDelta[key] = Math.max(row.maxDelta[key], delta[key]);
            if (failed || fields.some(key => Math.abs(delta[key]) >= 16 * 1048576)) {
                if (details++ < 20) emit({ type: 'operation', label, durationMs, failed: Boolean(failed), overlap,
                    activeAtStart, activeAtEnd: active, beforeMiB: mib(before), afterMiB: mib(after), deltaMiB: mib(delta) });
                else suppressed++;
            }
        };
    };
    const wrap = (label, fn) => {
        if (!enabled) return fn;
        return function (...args) {
            const finish = begin(label);
            try {
                const result = fn.apply(this, args);
                if (result && typeof result.then === 'function') return Promise.resolve(result).then(
                    value => { finish(false); return value; }, error => { finish(true); throw error; });
                finish(false);
                return result;
            } catch (error) { finish(true); throw error; }
        };
    };
    const sample = (label = 'periodic') => {
        if (!enabled) return;
        const candidates = [...rows.values()].filter(row => row.active || row.completed);
        candidates.sort((a, b) => Math.max(...Object.values(b.maxDelta)) - Math.max(...Object.values(a.maxDelta)));
        emit({ type: 'process', label, uptimeSeconds: Math.round(process.uptime()), memoryMiB: mib(usage()), active,
            trackedLabels: rows.size, omittedOperations: Math.max(0, candidates.length - 12), suppressedDetails: suppressed,
            activeOperations: candidates.filter(row => row.active).slice(0, 20).map(({ label, active }) => ({ label, active })),
            topOperations: candidates.slice(0, 12).map(({ maxDelta, ...row }) => ({ ...row, maxDeltaMiB: mib(maxDelta) })) });
        for (const row of rows.values()) {
            row.completed = row.errors = row.overlaps = row.maxDurationMs = 0;
            row.maxActive = row.active;
            for (const key of fields) row.maxDelta[key] = 0;
        }
        details = suppressed = 0;
    };
    const start = () => {
        if (!enabled || timer) return;
        sample('startup');
        timer = setInterval(sample, 30000);
        timer.unref?.();
    };
    const stop = () => { clearInterval(timer); timer = null; };
    // Preserve the socket object and listener receiver; intercept registration only.
    const registerSocket = (socket, register) => {
        if (!enabled) return register();
        const own = Object.hasOwn(socket, 'on'), original = socket.on;
        socket.on = function (event, handler) { return original.call(this, event, wrap(`socket:${event}`, handler)); };
        try { return register(); }
        finally { if (own) socket.on = original; else delete socket.on; }
    };
    return { begin, wrap, sample, start, stop, registerSocket };
}

const diagnostics = createMemoryDiagnostics({ enabled: process.env.MEMORY_DIAGNOSTICS === '1'
    || (process.env.NODE_ENV === 'production' && process.env.MEMORY_DIAGNOSTICS !== '0') });
module.exports = { ...diagnostics, createMemoryDiagnostics };
