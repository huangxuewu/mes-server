const assert = require('node:assert/strict');
const test = require('node:test');
const { productionTimes, getProductionOutput } = require('../utils/productionMetrics');

test('production time spans midnight and daylight saving with real elapsed durations', () => {
    const run = { startedAt: '2026-11-01T00:30:00-04:00', endedAt: '2026-11-01T02:30:00-05:00', events: [
        { action: 'pause', at: '2026-11-01T01:45:00-04:00' },
        { action: 'resume', at: '2026-11-01T01:15:00-05:00' },
    ] };
    assert.deepEqual(productionTimes(run, new Date('2026-11-02')), { elapsed: 10800000, paused: 1800000, running: 9000000 });
});

test('open pauses grow, ended pauses freeze, and zero duration never yields infinity', async () => {
    const run = { startedAt: '2026-09-07T23:00:00Z', events: [{ action: 'pause', at: '2026-09-07T23:30:00Z' }] };
    assert.deepEqual(productionTimes(run, new Date('2026-09-08T00:00:00Z')), { elapsed: 3600000, paused: 1800000, running: 1800000 });
    run.endedAt = '2026-09-08T00:00:00Z';
    assert.deepEqual(productionTimes(run, new Date('2026-09-10')), { elapsed: 3600000, paused: 1800000, running: 1800000 });
    const output = await getProductionOutput({}, null, new Date('2026-09-08T00:00:00Z'));
    assert.deepEqual(output.rates, { overall: null, running: null });
    assert.equal(output.buckets.length, 24);
    assert.equal(output.totals.pillows, 0);
});
