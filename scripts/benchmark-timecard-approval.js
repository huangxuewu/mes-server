// DATA_SYNC_TEST_URI must point to a disposable localhost replica set.
// Pass a git revision to compare it with the working tree.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { timecardApprovalFixture } = require('../test/support/timecardApprovalFixture');

(async () => {
    const revision = process.argv[2];
    const sources = revision ? Object.fromEntries(['models/timecard.js', 'socket/event/changeRequest.js', 'utils/changeRequestHandlers.js']
        .map(file => [file, execFileSync('git', ['show', `${revision}:${file}`], { cwd: __dirname, encoding: 'utf8' })])) : null;
    const results = [];
    for (const [version, source] of [...(sources ? [[revision, sources]] : []), ['working-tree', {}]]) {
        const runs = [];
        for (let index = 0; index < 5; index++) {
            const f = await timecardApprovalFixture(process.env.DATA_SYNC_TEST_URI, source);
            try {
                const started = performance.now();
                const result = await f.call();
                const elapsedMs = Math.round(performance.now() - started);
                assert.equal(result.status, 'success');
                assert.equal(result.payload.status, 'Approved');
                const operations = {};
                for (const command of f.commands) {
                    const name = ['find', 'getMore', 'findAndModify', 'update'].find(name => command[name]);
                    const key = `${name}:${command[name]}`;
                    operations[key] = (operations[key] || 0) + 1;
                }
                const saved = await f.db.timecard.findById(f.timecard._id);
                assert.equal(saved.totals.workMinutes, 510);
                assert.equal(saved.verifyIntegrity().isValid, true);
                runs.push({ elapsedMs, operations });
            } finally { await f.close(); }
        }
        results.push({ version, medianMs: runs.map(run => run.elapsedMs).sort((a, b) => a - b)[2], runs });
    }
    console.log(JSON.stringify({ environment: 'Five isolated localhost approvals per version; 200 KB employee portrait; no injected network latency', results }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
