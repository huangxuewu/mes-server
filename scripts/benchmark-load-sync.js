// DATA_SYNC_TEST_URI must point to a disposable localhost replica set.
// Pass a git revision to compare it with the working tree: node scripts/benchmark-load-sync.js HEAD
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { loadSyncFixture } = require('../test/support/loadSyncFixture');

(async () => {
    const revision = process.argv[2];
    const sources = revision ? Object.fromEntries(['models/order.js', 'models/outbound.js', 'socket/event/shipment.js']
        .map(file => [file, execFileSync('git', ['show', `${revision}:${file}`], { cwd: __dirname, encoding: 'utf8' })])) : null;
    const results = [];
    for (const [version, source] of [...(sources ? [[revision, sources]] : []), ['working-tree', {}]]) {
        const f = await loadSyncFixture(process.env.DATA_SYNC_TEST_URI, source);
        try {
            const count = 686;
            const numbers = Array.from({ length: count }, (_, index) => `TEST-${index}`);
            const items = [{ styleCode: 'TEST', quantity: 60, casePack: 6 }];
            await f.db.order.collection.insertMany(Array.from({ length: 41 }, (_, index) => ({
                poNumber: `MASTER-${index}`, orderStatus: 'Pending',
                buyers: numbers.filter((_, position) => position % 41 === index).map(poNumber => ({ poNumber, done: false, items })),
            })));
            await f.db.outbound.collection.insertMany(numbers.map(poNumber => ({ poNumber, items,
                loads: [{ shipmentId: `SHIP-${poNumber}`, status: 'Pending', items, cartons: 10 }] })));
            const payload = numbers.map(poNumber => ({ poNumber, load: { shipmentId: `SHIP-${poNumber}`, status: 'Picked Up' } }));
            for (const scenario of ['first import', 'unchanged reimport']) {
                f.commands.length = 0;
                const started = performance.now();
                const result = await f.sync(payload);
                assert.equal(result.status, 'success');
                const elapsedMs = Math.round(performance.now() - started);
                const commands = {};
                for (const command of f.commands) commands[command.name] = (commands[command.name] || 0) + 1;
                results.push({ version, scenario, shipments: count, orders: 41, elapsedMs, commands });
            }
            assert.equal(await f.db.order.countDocuments({ orderStatus: 'Completed' }), 41);
            assert.equal(await f.db.order.countDocuments({ 'buyers.done': false }), 0);
        } finally { await f.close(); }
    }
    console.log(JSON.stringify({ environment: 'Disposable localhost replica set; no injected network latency', results }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
