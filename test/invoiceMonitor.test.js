const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createInvoiceMonitor } = require('../utils/edi/invoiceMonitor');

test('invoice monitor resumes result retrieval and PDF saving without ever resubmitting', async () => {
    const calls = [];
    let query;
    let closed = 0;
    const records = [{ poNumber: 'PO1', invoiceDate: '2026-09-12' }, { poNumber: 'PO2', invoiceDate: '2026-09-12' }];
    const monitor = createInvoiceMonitor({
        db: { salesInvoice: { find: value => { query = value; return { lean: () => ({ cursor: () => ({
            async *[Symbol.asyncIterator]() { yield* records; }, close: async () => { closed++; },
        }) }) }; } } },
        getClient: async () => ({ config: { baseUrl: 'https://erp.example' }, headers: {} }),
        flow: { syncList: async () => { calls.push(['syncList']); }, refresh: async input => { calls.push(['refresh', input.poNumber]); if (input.poNumber === 'PO1') throw new Error('Orderful unavailable');
            return { canSavePdf: true, pdfPath: '' }; },
            savePdf: async input => { calls.push(['savePdf', input.poNumber]); },
            submit: () => { throw new Error('Monitor must never submit'); } }, logger: { error: () => {} },
    });
    await monitor.run();
    assert.deepEqual(calls, [['refresh', 'PO1'], ['refresh', 'PO2'], ['savePdf', 'PO2'], ['syncList']]);
    assert.equal(query.$and[1].$or[0].statusSource.$ne, 'orderful');
    assert.deepEqual(query.$and[1].$or[1].acknowledgmentStatus.$nin, ['REJECTED', 'ACCEPTEDWITHERRORS']);
    assert.equal(query.submittedBy.$exists, true);
    assert.equal(query.integrationKey.length, 64);
    assert.equal(closed, 1);
    await monitor.run();
    assert.equal(calls.length, 8);
});

test('overlapping invoice checks share a run and shutdown waits for the active request', async () => {
    let release;
    let refreshes = 0;
    const monitor = createInvoiceMonitor({
        db: { salesInvoice: { find: () => ({ lean: () => ({ cursor: () => ({
            async *[Symbol.asyncIterator]() { yield { poNumber: 'PO1' }; yield { poNumber: 'PO2' }; }, close: async () => {},
        }) }) }) } },
        getClient: async () => ({ config: { baseUrl: 'https://erp.example' }, headers: {} }),
        flow: { refresh: async () => { refreshes++; await new Promise(resolve => { release = resolve; }); return { canSavePdf: true }; },
            savePdf: () => { throw new Error('No save after shutdown'); } }, logger: { error: () => {} },
    });
    const first = monitor.run();
    const second = monitor.run();
    assert.equal(first, second);
    await new Promise(resolve => setImmediate(resolve));
    const stopping = monitor.stop();
    release();
    await stopping;
    await first;
    assert.equal(refreshes, 1);
    await monitor.run();
    assert.equal(refreshes, 1);
});
