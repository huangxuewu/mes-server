const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const mongoose = require('mongoose');

const uri = process.env.DATA_SYNC_TEST_URI;
const revision = process.argv[2];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const waitFor = async predicate => {
    const end = Date.now() + 60000;
    while (Date.now() < end) { if (await predicate()) return; await pause(20); }
    throw new Error('Capture benchmark timed out');
};

(async () => {
    assert.match(uri || '', /^mongodb:\/\/(127\.0\.0\.1|localhost):\d+\/data_sync_test_[a-z\d_]+(?:\?|$)/i);
    const results = [];
    for (const version of [...(revision ? [revision] : []), 'working-tree']) {
        const filename = path.join(__dirname, '../utils/dataSync.js');
        const source = version === 'working-tree' ? fs.readFileSync(filename, 'utf8')
            : execFileSync('git', ['show', `${version}:utils/dataSync.js`], { cwd: __dirname, encoding: 'utf8' });
        const module = { exports: {} };
        vm.runInNewContext(source, { module, require: createRequire(filename), Date, Buffer, setTimeout, clearTimeout });
        const dbName = `data_sync_test_benchmark_${randomUUID().replaceAll('-', '')}`;
        const connection = await mongoose.createConnection(uri, { dbName, monitorCommands: true }).asPromise();
        const observer = await mongoose.createConnection(uri, { dbName }).asPromise();
        const commands = {};
        let recording = false, notifications = 0;
        connection.getClient().on('commandStarted', event => {
            if (recording) commands[event.commandName] = (commands[event.commandName] || 0) + 1;
        });
        const sync = module.exports.createDataSync({ connection,
            getBusinessContext: async () => ({ businessDate: '2026-09-13', timeZone: 'America/New_York' }),
            notify: () => { if (recording) notifications++; }, logger: { info() {}, warn() {}, error() {} },
        });
        try {
            sync.start();
            await waitFor(async () => (await sync.status()).capture.available);
            await pause(6500); // Exclude the initial retention sweep from both versions.
            recording = true;
            const started = performance.now();
            await observer.db.collection('outbound').insertMany(Array.from({ length: 1000 }, (_, index) => ({
                poNumber: `TEST-${index}`, loads: [{ shipmentId: `SHIP-${index}`, status: 'Pending' }],
            })));
            const writeAckMs = Math.round(performance.now() - started);
            await waitFor(async () => (await observer.db.collection('syncState').findOne({ _id: 'application-data-v2' }))?.datasets.outbound.head === 1000);
            const captureCompleteMs = Math.round(performance.now() - started);
            recording = false;
            const entries = await observer.db.collection('syncJournalV2').find({ dataset: 'outbound' }).sort({ sequence: 1 }).toArray();
            assert.deepEqual(entries.map(entry => entry.sequence), Array.from({ length: 1000 }, (_, i) => i + 1));
            results.push({ version, events: 1000, writeAckMs, captureCompleteMs, notifications, commands });
        } finally {
            await sync.stop(); await connection.dropDatabase(); await connection.close(); await observer.close();
        }
    }
    console.log(JSON.stringify({ environment: 'Disposable localhost replica set; no injected network latency', results }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
