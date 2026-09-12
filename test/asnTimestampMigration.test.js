const { test } = require('node:test');
const assert = require('node:assert/strict');
const { migrateAsnTimestamps } = require('../scripts/migrate-asn-timestamps');

test('migration updates pass the real outbound schema and preserve conditional leaf filters', async () => {
    const mongoose = require('mongoose');
    const fs = require('node:fs');
    const vm = require('node:vm');
    const { EventEmitter } = require('node:events');
    let schema;
    const dependencies = { mongoose, '../socket/io': { io: {} }, '../utils/outboundScac': {},
        '../config/database': { model: (_name, definition) => { schema = definition; return { watch: () => new EventEmitter(), createIndexes() {}, hooks: { pre() {} } }; } } };
    vm.runInNewContext(fs.readFileSync(require.resolve('../models/outbound'), 'utf8'), {
        module: { exports: {} }, require: name => dependencies[name],
    });
    const connection = mongoose.createConnection();
    const model = connection.model('MigrationSchemaCheck', schema);
    const f = fixture();
    f.document._id = new mongoose.Types.ObjectId();
    await migrateAsnTimestamps({ ...f.options, apply: true });
    let checked = false;
    // Intercept the driver boundary: exercise casting/validation without a database or writes.
    model.collection.updateOne = async (filter, update, options) => {
        assert.equal(filter.loads.$elemMatch['checklist.noticed.status'], false);
        assert.deepEqual(options.arrayFilters[0]['target.asn.source'], { $exists: false });
        assert.equal(update.$set['loads.$[target].asn'].source, 'orderful');
        assert.equal(update.$set['loads.$[target].checklist.noticed.timestamp'].toISOString(), '2026-09-11T21:00:00.000Z');
        assert.equal(update.$set['loads.$[target].checklist.noticed.acceptedAt'].toISOString(), '2026-09-11T21:03:00.000Z');
        checked = true;
        return { modifiedCount: 0 };
    };
    await model.updateOne(...f.writes[0]);
    assert.equal(checked, true);
    await connection.close();
});

const fixture = () => {
    const load = { loadNumber: 'L1', shipmentId: 'S1', status: 'Completed', checklist: { noticed: { status: false, timestamp: null } } };
    const document = { _id: 'D1', client: 'Target', poNumber: 'PO1-0551', loads: [load] };
    const transaction = { id: '100', transaction_type: '856', stream: 'LIVE', sender_isa_id: 'OFDHTGTDMS', receiver_isa_id: '6111470100',
        business_number: '10', created_at: '2026-09-11T21:00:00Z', validation_status: 'VALID', delivery_status: 'DELIVERED', acknowledgment_status: 'ACCEPTED' };
    const po = { po_number: document.poNumber, load_shipments: [{ id: '10', load_shipment_notice_id: 'S1', load: { load_number: 'L1' },
        shipment_notice: { shipment_id: 'S1' }, shipment_tracking: { asn_sent_at: '2026-09-11T23:00:00Z' } }], edi_transaction: [transaction] };
    const metadata = { id: '100', type: { name: '856_SHIP_NOTICE_MANIFEST' }, sender: { isaId: 'OFDHTGTDMS' }, receiver: { isaId: '6111470100' },
        stream: 'LIVE', businessNumber: '10', createdAt: '2026-09-11T21:00:00Z', validationStatus: 'VALID', deliveryStatus: 'DELIVERED', acknowledgmentStatus: 'ACCEPTED' };
    const acknowledgment = { transactionId: '100', status: 'ACCEPTED', createdAt: '2026-09-11T21:03:00Z' };
    const message = { transactionSets: [{ transactionSetHeader: [{ transactionSetIdentifierCode: '856' }],
        beginningSegmentForShipNotice: [{ shipmentIdentification: '10' }], HL_loop: [{ purchaseOrderReference: [{ purchaseOrderNumber: document.poNumber }] }] }] };
    const writes = [];
    const reports = [];
    let lookup = 0;
    const options = { poNumbers: [document.poNumber],
        db: { outbound: { find: () => ({ lean: async () => [document] }), updateOne: async (...args) => { writes.push(args); return { modifiedCount: 1 }; } } },
        client: { graphql: async () => { lookup++; return { po: { edges: [{ node: structuredClone(po) }], pageInfo: { hasNextPage: false } } }; } },
        getOrderful: async (id, suffix = '') => ({ '': metadata, '/acknowledgment': acknowledgment, '/message': message })[suffix],
        onReport: async report => reports.push(structuredClone(report)) };
    return { document, load, po, transaction, metadata, acknowledgment, message, writes, reports, options, lookups: () => lookup };
};

test('dry run recovers historical Orderful times rather than later ERP tracking times, without writes', async () => {
    const f = fixture();
    const report = await migrateAsnTimestamps(f.options);
    assert.equal(f.writes.length, 0);
    assert.deepEqual(report.counts, { 'would-update': 1 });
    const changes = report.rows[0].changes;
    assert.equal(changes['checklist.noticed.timestamp'].toISOString(), f.metadata.createdAt.replace('Z', '.000Z'));
    assert.equal(changes['checklist.noticed.acceptedAt'].toISOString(), f.acknowledgment.createdAt.replace('Z', '.000Z'));
    assert.equal(changes['checklist.noticed.status'], true);
    assert.equal(changes.asn.transactionId, '100');
    assert.equal(f.load.checklist.noticed.status, false);
});

test('apply saves a backup first, rechecks latest ASN and updates only the unchanged target load', async () => {
    const f = fixture();
    const originalWrite = f.options.db.outbound.updateOne;
    f.options.db.outbound.updateOne = (...args) => {
        assert.equal(f.reports[0].rows[0].before.noticed.status, false);
        return originalWrite(...args);
    };
    const report = await migrateAsnTimestamps({ ...f.options, apply: true });
    assert.equal(f.lookups(), 2);
    assert.equal(report.rows[0].outcome, 'updated');
    const [filter, update, options] = f.writes[0];
    assert.equal(filter.client, 'Target');
    assert.equal(filter.loads.$elemMatch.shipmentId, 'S1');
    assert.equal(options.arrayFilters[0]['target.checklist.noticed.status'], false);
    assert.deepEqual(options.arrayFilters[0]['target.asn.transactionId'], { $exists: false });
    assert.deepEqual(options.arrayFilters[0]['target.checklist.noticed.acceptedAt'], { $exists: false });
    assert.equal(update.$set['loads.$[target].checklist.noticed.status'], true);
    assert.equal(Object.hasOwn(update.$set, 'loads'), false);
});

test('incorrect existing timestamps are corrected from Orderful and a verified rerun is a no-op', async () => {
    const f = fixture();
    f.load.checklist.noticed = { status: true, timestamp: new Date('2026-09-11T20:59:59Z'), acceptedAt: new Date('2026-09-11T21:04:00Z') };
    const report = await migrateAsnTimestamps(f.options);
    assert.equal(report.rows[0].changes['checklist.noticed.timestamp'].toISOString(), '2026-09-11T21:00:00.000Z');
    f.load.checklist.noticed.timestamp = report.rows[0].changes['checklist.noticed.timestamp'];
    f.load.checklist.noticed.acceptedAt = report.rows[0].changes['checklist.noticed.acceptedAt'];
    f.load.asn = report.rows[0].changes.asn;
    assert.equal((await migrateAsnTimestamps({ ...f.options, apply: true })).rows[0].outcome, 'unchanged');
    assert.equal(f.writes.length, 0);
});

for (const scenario of ['wrongPo', 'wrongAccount', 'wrongAck', 'rejectedAck', 'timeReversed', 'replacement', 'wrongLoad', 'ambiguousDate', 'missingDate', 'malformedChecklist'])
    test(`migration skips ${scenario} without database writes`, async () => {
        const f = fixture();
        if (scenario === 'wrongPo') f.message.transactionSets[0].HL_loop[0].purchaseOrderReference[0].purchaseOrderNumber = 'OTHER';
        if (scenario === 'wrongAccount') f.metadata.receiver.isaId = 'OTHER';
        if (scenario === 'wrongAck') f.acknowledgment.transactionId = '101';
        if (scenario === 'rejectedAck') f.acknowledgment.status = 'REJECTED';
        if (scenario === 'timeReversed') f.acknowledgment.createdAt = '2026-09-10T00:00:00Z';
        if (scenario === 'replacement') f.load.asn = { transactionId: '101' };
        if (scenario === 'wrongLoad') f.po.load_shipments[0].load.load_number = 'OTHER';
        if (scenario === 'ambiguousDate') f.po.edi_transaction.push({ ...f.transaction, id: '101', created_at: 'invalid' });
        if (scenario === 'missingDate') f.acknowledgment.createdAt = null;
        if (scenario === 'malformedChecklist') f.load.checklist.noticed = null;
        assert.equal((await migrateAsnTimestamps({ ...f.options, apply: true })).rows[0].outcome, 'skipped');
        assert.equal(f.writes.length, 0);
    });

test('backup failure prevents database writes', async () => {
    const f = fixture();
    f.options.onReport = async () => { throw new Error('Report disk unavailable'); };
    await assert.rejects(migrateAsnTimestamps({ ...f.options, apply: true }), /Report disk unavailable/);
    assert.equal(f.writes.length, 0);
});

test('changed ERP ASN and concurrently changed MES loads cannot be overwritten', async () => {
    const f = fixture();
    const graphql = f.options.client.graphql;
    f.options.client.graphql = async (...args) => {
        if (f.lookups()) f.po.edi_transaction[0].id = '101';
        return graphql(...args);
    };
    assert.equal((await migrateAsnTimestamps({ ...f.options, apply: true })).rows[0].outcome, 'skipped');
    assert.equal(f.writes.length, 0);
    const concurrent = fixture();
    concurrent.options.db.outbound.updateOne = async () => ({ modifiedCount: 0 });
    assert.equal((await migrateAsnTimestamps({ ...concurrent.options, apply: true })).rows[0].outcome, 'stale');
});

test('migration uses Orderful acceptance even when ERP still reports pending and has the wrong date', async () => {
    const f = fixture();
    f.transaction.acknowledgment_status = 'NOT_ACKNOWLEDGED';
    f.transaction.created_at = '2020-01-01';
    const result = await migrateAsnTimestamps(f.options);
    assert.equal(result.rows[0].outcome, 'would-update');
    assert.equal(result.rows[0].changes.asn.source, 'orderful');
    assert.equal(result.rows[0].changes['checklist.noticed.timestamp'].toISOString(), '2026-09-11T21:00:00.000Z');
});
