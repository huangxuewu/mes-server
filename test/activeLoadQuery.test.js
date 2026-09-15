const assert = require('node:assert/strict');
const test = require('node:test');
const { Types: { ObjectId } } = require('mongoose');
const { loadSyncFixture } = require('./support/loadSyncFixture');

const uri = process.env.DATA_SYNC_TEST_URI;

test('active loads filter before BOL enrichment and retain only active children across POs', { skip: !uri }, async t => {
    const f = await loadSyncFixture(uri);
    t.after(() => f.close());
    await f.db.outbound.collection.insertMany([
        { poNumber: 'PO1', loads: [
            { shipmentId: 's1', loadNumber: 'L1', status: 'Carrier Accepted, Awaiting Pickup' },
            { shipmentId: 'old', loadNumber: 'OLD', status: 'Completed' },
        ] },
        { poNumber: 'PO2', loads: [{ shipmentId: 's2', loadNumber: 'L1', status: 'Past Pickup' }] },
        { poNumber: 'PO3', loads: [{ shipmentId: 's3', loadNumber: 'L2', status: 'Completed' }] },
    ]);
    f.commands.length = 0;
    const loads = await f.db.outbound.getActiveLoads();
    assert.equal(loads.length, 1);
    assert.equal(loads[0].loadNumber, 'L1');
    assert.deepEqual(loads[0].loads.map(row => row.shipmentId).sort(), ['s1', 's2']);
    assert.ok(loads[0].loads.every(row => row.bolSummary && !Object.hasOwn(row, 'bol')));
    const pipeline = f.commands.find(entry => entry.name === 'aggregate').command.pipeline;
    assert.ok(pipeline[0].$match['loads.status']);
    assert.ok(pipeline[1].$lookup);
});

test('targeted load reads filter parents before BOL lookup and preserve shared BOL summaries', { skip: !uri }, async t => {
    const f = await loadSyncFixture(uri);
    t.after(() => f.close());
    const document = await f.db.bolDocument.collection.insertOne({ loadNumber: 'L1', number: 'BOL1', rawData: { note: 'private document body' }, revision: 2 });
    await f.db.outbound.collection.insertMany([
        { poNumber: 'PO1', loads: [
            { shipmentId: 's1', loadNumber: 'L1', pickupDate: '2026-09-15', bolId: document.insertedId },
            { shipmentId: 'other', loadNumber: 'L2', pickupDate: '2026-09-16' },
        ] },
        { poNumber: 'PO2', loads: [{ shipmentId: 's2', loadNumber: 'L1', pickupDate: '2026-09-15', bolId: document.insertedId }] },
        { poNumber: 'PO3', loads: [{ shipmentId: 's3', loadNumber: 'L3', pickupDate: '2026-09-16' }] },
    ]);
    for (const query of [{ loadNumber: 'L1' }, { pickupDate: '2026-09-15' }]) {
        f.commands.length = 0;
        let response;
        await f.handlers['loads:query'](query, result => { response = result; });
        assert.equal(response.status, 'success');
        assert.deepEqual(response.payload.map(row => row.shipmentId).sort(), ['s1', 's2']);
        assert.ok(response.payload.every(row => row.bolSummary.number === 'BOL1' && row.bolSummary.hasRawData));
        assert.ok(response.payload.every(row => !row.bolSummary.rawData));
        const pipeline = f.commands.find(entry => entry.name === 'aggregate').command.pipeline;
        assert.deepEqual(JSON.parse(JSON.stringify(pipeline[0].$match)), { [`loads.${Object.keys(query)[0]}`]: Object.values(query)[0] });
        assert.ok(pipeline[1].$lookup);
    }
});

test('history filters run before enrichment only when they do not depend on BOL fields', { skip: !uri }, async t => {
    const f = await loadSyncFixture(uri);
    t.after(() => f.close());
    const document = await f.db.bolDocument.collection.insertOne({ number: 'BOL1', loadNumber: 'L1' });
    await f.db.outbound.collection.insertMany([
        { poNumber: 'PO1', loads: [{ loadNumber: 'L1', status: 'Completed', bolId: document.insertedId }] },
        { poNumber: 'PO2', loads: [{ loadNumber: 'L2', status: 'Loading' }] },
    ]);
    for (const filter of [{ status: 'Completed' }, { 'bolSummary.number': 'BOL1' }]) {
        f.commands.length = 0;
        let result;
        await f.handlers['outbound:aggregate']([{ $match: { loads: { $elemMatch: filter } } }], response => { result = response; });
        assert.equal(result.status, 'success');
        assert.deepEqual(result.payload.map(row => row.poNumber), ['PO1']);
        assert.equal(result.payload[0].loads[0].bolSummary.number, 'BOL1');
        const pipeline = f.commands.find(entry => entry.name === 'aggregate').command.pipeline;
        assert.equal(Boolean(pipeline[0].$match), Boolean(filter.status));
    }
});

test('monthly load counts deduplicate POs without joining BOL documents', { skip: !uri }, async t => {
    const f = await loadSyncFixture(uri);
    t.after(() => f.close());
    await f.db.outbound.collection.insertMany([
        { poNumber: 'PO1', loads: [{ loadNumber: 'L1', pickupDate: '2026-09-15' }, { loadNumber: 'L2', pickupDate: '2026-09-16' }] },
        { poNumber: 'PO2', loads: [{ loadNumber: 'L1', pickupDate: '2026-09-15' }, { loadNumber: 'L1', pickupDate: '2026-08-01' }] },
        { poNumber: 'PO3', loads: [{ pickupDate: '2026-09-15' }, { loadNumber: '', pickupDate: '2026-09-15' }, { loadNumber: null }] },
    ]);
    f.commands.length = 0;
    let result;
    await f.handlers['outbound:load-counts']({}, response => { result = response; });
    assert.equal(result.status, 'success');
    assert.deepEqual(Object.fromEntries(result.payload.map(row => [row._id, row.count])), { '2026-08': 1, '2026-09': 2 });
    const pipeline = f.commands.find(entry => entry.name === 'aggregate').command.pipeline;
    assert.ok(!pipeline.some(stage => stage.$lookup));
});

test('global search scans outbound once and batches referenced BOL numbers with no document bodies', { skip: !uri }, async t => {
    const f = await loadSyncFixture(uri);
    t.after(() => f.close());
    const document = await f.db.bolDocument.collection.insertOne({ number: '840123456789', loadNumber: 'L1', rawData: { note: 'private body' } });
    await f.db.order.collection.insertOne({ poNumber: 'MASTER', buyers: [{ poNumber: '12345', done: false, items: [{ description: 'large detail' }] }] });
    await f.db.outbound.collection.insertMany([
        { poNumber: 'PO1', loads: [{ loadNumber: 'L1', status: 'Loading', bolId: document.insertedId }] },
        { poNumber: 'PO2', loads: [{ loadNumber: 'L1', status: 'Loading', bolId: document.insertedId }] },
        { poNumber: 'PO3', loads: [{ loadNumber: 'L2', status: 'Completed' }, { loadNumber: '' }] },
    ]);
    f.commands.length = 0;
    let result;
    await f.handlers['search:cache'](response => { result = response; });
    assert.equal(result.status, 'success');
    const [orders, loads, bols] = result.payload;
    assert.equal(orders[0].poNumber, '12345');
    assert.deepEqual(Array.from(loads, row => row.loadNumber).sort(), ['L1', 'L2']);
    assert.equal(bols.length, 1);
    assert.equal(bols[0].bol, '840123456789');
    assert.ok(bols[0]._id);
    assert.ok(!JSON.stringify(result).includes('private body') && !JSON.stringify(result).includes('large detail'));
    const reads = f.commands.filter(entry => entry.name === 'aggregate' && entry.command.aggregate === 'outbound');
    assert.equal(reads.length, 1);
    assert.ok(!reads[0].command.pipeline.some(stage => stage.$lookup));
    const bolReads = f.commands.filter(entry => entry.name === 'find' && entry.command.find === 'bolDocument');
    assert.equal(bolReads.length, 1);
    assert.equal(bolReads[0].command.filter._id.$in.length, 1);
    assert.deepEqual(bolReads[0].command.projection, { number: 1 });
});

test('BOL search retains the first shipment when standalone documents share a number', { skip: !uri }, async t => {
    const f = await loadSyncFixture(uri);
    t.after(() => f.close());
    const firstBol = new ObjectId(), secondBol = new ObjectId();
    const laterId = new ObjectId('000000000000000000000002');
    const earlierId = new ObjectId('000000000000000000000001');
    await f.db.bolDocument.collection.insertMany([
        { _id: firstBol, number: 'SHARED', loadNumber: 'L1' },
        { _id: secondBol, number: 'SHARED', loadNumber: 'L2' },
    ]);
    await f.db.outbound.collection.insertMany([
        { _id: laterId, poNumber: 'FIRST', loads: [{ loadNumber: 'L1', status: 'Loading', bolId: secondBol }] },
        { _id: earlierId, poNumber: 'SECOND', loads: [{ loadNumber: 'L2', status: 'Completed', bolId: firstBol }] },
    ]);
    let result;
    await f.handlers['search:cache'](response => { result = response; });
    assert.equal(result.status, 'success');
    assert.equal(result.payload[2].length, 1);
    assert.equal(String(result.payload[2][0]._id), String(laterId));
    assert.equal(result.payload[2][0].status, 'Loading');
});
