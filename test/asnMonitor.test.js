const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createAsnMonitor, ASN_CHECK_INTERVAL_MS } = require('../utils/edi/asnMonitor');
const { INVOICE_QUERY, REFRESH_INVOICE, accepted } = require('../utils/edi/invoice');

const setup = () => {
    const transaction = { id: '100', transaction_type: '856', business_number: '10', created_at: '2026-09-12',
        stream: 'LIVE', sender_isa_id: 'OFDHTGTDMS', receiver_isa_id: '6111470100',
        validation_status: 'VALID', delivery_status: 'DELIVERED', acknowledgment_status: 'NOT_ACKNOWLEDGED' };
    const document = { _id: '1', client: 'Target', poNumber: '10001234567-0551', loads: [{
        shipmentId: 'SIQ1', loadNumber: '123', checklist: { noticed: { status: true, timestamp: new Date('2026-09-12') } },
    }] };
    const po = { po_number: document.poNumber, edi_transaction: [transaction], load_shipments: [{
        id: '10', load_shipment_notice_id: 'SIQ1', shipment_notice: { shipment_id: 'SIQ1' }, load: { load_number: '123' },
    }] };
    const documents = [document];
    const calls = [];
    const errors = [];
    const queries = [];
    let closed = 0;
    let onRefresh = async () => structuredClone(transaction);
    const db = { outbound: {
        find: query => {
            queries.push(query);
            return { lean: () => ({ cursor: () => ({
                async *[Symbol.asyncIterator]() {
                    for (const value of documents) if (value.client === 'Target' && value.loads.some(load => load.checklist?.noticed?.status && !load.asn?.final))
                        yield structuredClone(value);
                },
                close: async () => { closed++; },
            }) }) };
        },
        updateOne: async (query, update, options) => {
            const value = documents.find(item => item._id === query._id && item.client === query.client);
            const filter = options.arrayFilters[0];
            for (const load of value.loads) if (load.shipmentId === filter['target.shipmentId'] && load.loadNumber === filter['target.loadNumber']
                && (load.asn?.transactionId ?? null) === filter['target.asn.transactionId']
                && +(load.asn?.checkedAt ?? null) === +filter['target.asn.checkedAt']
                && +load.checklist.noticed.timestamp === +filter['target.checklist.noticed.timestamp'])
                load.asn = update.$set['loads.$[target].asn'];
        },
    } };
    const client = { graphql: async (query, variables) => {
        calls.push({ query, variables });
        if (query === INVOICE_QUERY) return { po: { edges: [{ node: structuredClone(po) }], pageInfo: { hasNextPage: false } } };
        assert.equal(query, REFRESH_INVOICE);
        return { refreshTransaction: await onRefresh(variables) };
    } };
    const monitor = createAsnMonitor({ db, getClient: async () => client, logger: { error: (...args) => errors.push(args) } });
    return { monitor, document, documents, po, transaction, calls, queries, errors,
        closed: () => closed, onRefresh: handler => { onRefresh = handler; } };
};

test('discovers legacy noticed Target POs, polls pending/overdue, then persists acceptance and stops polling', async () => {
    const state = setup();
    state.documents.push({ ...structuredClone(state.document), _id: '2', client: 'Other customer' });
    state.documents.push({ ...structuredClone(state.document), _id: '3', loads: [{ checklist: { noticed: { status: false } } }] });
    await state.monitor.run();
    assert.equal(state.document.loads[0].asn.state, 'pending');
    assert.equal(state.document.loads[0].asn.transactionId, '100');
    assert.equal(state.queries[0].client, 'Target');
    assert.deepEqual(state.queries[0].loads.$elemMatch, { 'checklist.noticed.status': true, 'asn.final': { $ne: true } });
    state.transaction.acknowledgment_status = 'OVERDUE';
    await state.monitor.run();
    assert.equal(state.document.loads[0].asn.final, false);
    assert.equal(accepted(state.transaction), false);
    state.transaction.acknowledgment_status = 'ACCEPTED';
    await state.monitor.run();
    assert.equal(state.document.loads[0].asn.state, 'accepted');
    assert.equal(state.document.loads[0].asn.final, true);
    assert.equal(accepted(state.transaction), true);
    const count = state.calls.length;
    await state.monitor.run();
    assert.equal(state.calls.length, count);
    assert.equal(state.closed(), 4);
    assert.equal(ASN_CHECK_INTERVAL_MS, 300000);
});

test('rejected acknowledgments are final failures; transient delivery failures continue checking', async () => {
    const state = setup();
    state.transaction.delivery_status = 'FAILED';
    await state.monitor.run();
    assert.equal(state.document.loads[0].asn.state, 'failed');
    assert.equal(state.document.loads[0].asn.final, false);
    state.transaction.delivery_status = 'DELIVERED';
    state.transaction.acknowledgment_status = 'REJECTED';
    await state.monitor.run();
    assert.equal(state.document.loads[0].asn.state, 'failed');
    assert.equal(state.document.loads[0].asn.final, true);
    assert.equal(accepted(state.transaction), false);
});

test('a failed PO check does not stop other noticed POs and a later interval recovers', async () => {
    const state = setup();
    state.documents.unshift({ ...structuredClone(state.document), _id: '2', poNumber: 'NOT_FOUND' });
    await state.monitor.run();
    assert.match(state.documents[0].loads[0].asn.error, /not found uniquely/);
    assert.equal(state.document.loads[0].asn.state, 'pending');
    state.onRefresh(async () => { throw new Error('ERP unavailable'); });
    await state.monitor.run();
    assert.match(state.document.loads[0].asn.error, /ERP unavailable/);
    state.transaction.acknowledgment_status = 'ACCEPTED';
    state.onRefresh(async () => structuredClone(state.transaction));
    await state.monitor.run();
    assert.equal(state.document.loads[0].asn.state, 'accepted');
    assert.equal(state.document.loads[0].asn.error, '');
});

test('wrong account, shipment or transaction cannot mark a PO accepted', async () => {
    for (const patch of [{ receiver_isa_id: 'OTHER' }, { business_number: 'OTHER' }, { id: '999' }, { transaction_type: '810' }]) {
        const state = setup();
        state.onRefresh(async () => ({ ...state.transaction, ...patch, acknowledgment_status: 'ACCEPTED' }));
        await state.monitor.run();
        assert.equal(state.document.loads[0].asn.final, false);
        assert.match(state.document.loads[0].asn.error, /different shipment or account/);
    }
});

test('checks the latest replacement ASN instead of an older accepted transaction', async () => {
    const state = setup();
    state.transaction.acknowledgment_status = 'ACCEPTED';
    const newer = { ...state.transaction, id: '101', created_at: '2026-09-13', acknowledgment_status: 'NOT_ACKNOWLEDGED' };
    state.po.edi_transaction.push(newer);
    state.onRefresh(async variables => { assert.equal(variables.id, 101); return newer; });
    await state.monitor.run();
    assert.equal(state.document.loads[0].asn.state, 'pending');
    assert.equal(state.document.loads[0].asn.transactionId, '101');
});

test('a newly submitted ASN never inherits acceptance from an older ASN still visible in ERP', async () => {
    const state = setup();
    state.document.loads[0].asn = { transactionId: '101', state: 'pending', final: false };
    state.transaction.acknowledgment_status = 'ACCEPTED';
    await state.monitor.run();
    assert.equal(state.document.loads[0].asn.transactionId, '101');
    assert.equal(state.document.loads[0].asn.state, 'pending');
    assert.equal(state.document.loads[0].asn.final, false);
    assert.match(state.document.loads[0].asn.error, /Waiting for the submitted ASN/);
    assert.equal(state.calls.filter(call => call.query === REFRESH_INVOICE).length, 0);
});

test('overlapping intervals share one run and in-flight checks cannot overwrite a resubmitted ASN', async () => {
    const state = setup();
    let release;
    let entered;
    const started = new Promise(resolve => { entered = resolve; });
    state.onRefresh(async () => { entered(); await new Promise(resolve => { release = resolve; }); return state.transaction; });
    const first = state.monitor.run();
    await started;
    const second = state.monitor.run();
    state.document.loads[0].asn = { transactionId: 'NEW', state: 'pending', final: false };
    state.document.loads[0].checklist.noticed.timestamp = new Date('2026-09-13');
    release();
    await Promise.all([first, second]);
    assert.equal(state.calls.filter(call => call.query === REFRESH_INVOICE).length, 1);
    assert.equal(state.document.loads[0].asn.transactionId, 'NEW');
    await state.monitor.stop();
    await state.monitor.run();
    assert.equal(state.closed(), 1);
});
