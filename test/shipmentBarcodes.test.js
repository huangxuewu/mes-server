const test = require('node:test');
const assert = require('node:assert/strict');
const { loadSyncFixture } = require('./support/loadSyncFixture');
const { createSignaturePadWorkflow } = require('../utils/signaturePadWorkflow');
const uri = process.env.DATA_SYNC_TEST_URI;

for (const event of ['load:sync', 'load:replace']) test(`${event} rejects a stale snapshot without erasing a concurrent inspection`, { skip: !uri }, async t => {
    const f = await loadSyncFixture(uri); t.after(() => f.close());
    const items = [{ styleCode: '1234', quantity: 120, casePack: 12 }];
    const parent = await f.db.outbound.create({ poNumber: 'PO-001', items });
    const call = async (name, input) => { let result; await f.handlers[name](JSON.parse(JSON.stringify(input)), response => { result = response; }); return result; };
    assert.equal((await call('load:add', { _id: parent._id, load: { shipmentId: 'SHIP', loadNumber: 'LOAD', status: 'Pending', items } })).status, 'success');
    await call('load:update', { shipmentId: 'SHIP', checklist: { labeled: { status: true } } });
    const before = await f.db.outbound.findById(parent._id).lean();
    const workflow = createSignaturePadWorkflow({ models: f.db, secret: 'concurrent-review-test' });
    const device = { _id: 'test-pad' };
    const { grant } = await workflow.lookup(device, before.loads[0].checklist.inspected.barcode);
    const originalWrite = f.db.outboundWorkflowState.findOneAndUpdate.bind(f.db.outboundWorkflowState);
    let confirmed, entered = false;
    f.db.outboundWorkflowState.findOneAndUpdate = async (...args) => {
        if (!entered) { entered = true; confirmed = await workflow.confirm(device, { grant, shipmentIds: ['SHIP'] }); }
        return originalWrite(...args);
    };
    const load = { shipmentId: 'SHIP', loadNumber: 'LOAD', proNumber: 'NEW-PRO' };
    const input = event === 'load:sync' ? [{ poNumber: parent.poNumber, load }] : { _id: parent._id, load };
    const result = await call(event, input);
    f.db.outboundWorkflowState.findOneAndUpdate = originalWrite;
    assert.equal(result.status, 'error'); assert.match(result.message, /changed/i);
    const after = await f.db.outbound.findById(parent._id).lean();
    assert.equal(after.loads[0].checklist.inspected.status, true);
    assert.equal(+after.loads[0].checklist.inspected.timestamp, +confirmed.shipments[0].timestamp);
    assert.notEqual(after.loads[0].proNumber, 'NEW-PRO');
    // A repeat import may contain a stale checklist; ERP metadata does not own warehouse statuses.
    if (event === 'load:sync') load.checklist = before.loads[0].checklist;
    assert.equal((await call(event, input)).status, 'success');
    const retried = await f.db.outbound.findById(parent._id).lean();
    assert.equal(retried.loads[0].proNumber, 'NEW-PRO');
    assert.equal(retried.loads[0].checklist.inspected.status, true);
    assert.equal(+retried.loads[0].checklist.inspected.timestamp, +confirmed.shipments[0].timestamp);
    for (const action of ['picked', 'inspected', 'labeled'])
        assert.equal(retried.loads[0].checklist[action].barcode, before.loads[0].checklist[action].barcode);
});

test('shipment creation saves short codes; scans, status updates and repeat sync preserve their identities', { skip: !uri }, async t => {
    const f = await loadSyncFixture(uri); t.after(() => f.close());
    const items = [{ styleCode: '1234', quantity: 120, casePack: 12 }];
    const parents = await f.db.outbound.create([{ poNumber: '12345-001', items }, { poNumber: '12345-002', items }]);
    const call = async (event, input) => { let result; await f.handlers[event](input, response => { result = response; }); assert.equal(result.status, 'success', result.message); return result; };
    await Promise.all(parents.map((parent, i) => call('load:add', { _id: parent._id,
        load: { shipmentId: 'SHIP-' + i, loadNumber: 'LOAD-1', items, status: 'Pending', carrierSCAC: 'ABCD' } })));
    let records = await f.db.outbound.find().sort({ poNumber: 1 }).lean();
    const original = records.map(record => record.loads[0].checklist);
    const codes = original.flatMap(checklist => ['picked', 'inspected', 'labeled'].map(action => checklist[action].barcode));
    assert.equal(new Set(codes).size, 6); assert.ok(codes.every(code => /^40[234]\d{9}$/.test(code)));
    assert.equal((await f.db.counter.findById('signature-pad-checklist')).sequence, 6);
    const workflow = createSignaturePadWorkflow({ models: f.db, secret: 'local-barcode-test' });
    const device = { _id: 'test-pad' };
    await assert.rejects(workflow.lookup(device, '403999999999'), /workflowNotFound/);
    await assert.rejects(workflow.lookup(device, '403' + original[0].picked.barcode.slice(3)), /workflowNotFound/);
    const pick = await workflow.lookup(device, original[0].picked.barcode);
    assert.equal(pick.shipments.length, 2, 'Picking code opens the entire load');
    const label = await workflow.lookup(device, original[1].labeled.barcode);
    assert.equal(label.shipments.length, 1); assert.equal(label.shipments[0].shipmentId, 'SHIP-1');
    await workflow.confirm(device, { grant: label.grant, shipmentIds: ['SHIP-1'] });
    await call('load:update', { shipmentId: 'SHIP-1', checklist: { picked: { status: true, timestamp: new Date(), barcode: '404999999999' } } });
    await call('load:sync', parents.map((parent, i) => ({ poNumber: parent.poNumber, load: { shipmentId: 'SHIP-' + i, loadNumber: 'LOAD-1', carrierSCAC: 'ABCD' } })));
    records = await f.db.outbound.find().sort({ poNumber: 1 }).lean();
    for (let i = 0; i < records.length; i++) for (const action of ['picked', 'inspected', 'labeled'])
        assert.equal(records[i].loads[0].checklist[action].barcode, original[i][action].barcode);
    assert.equal(records[1].loads[0].checklist.labeled.status, true);
    assert.equal((await f.db.counter.findById('signature-pad-checklist')).sequence, 6, 'Re-sync does not allocate numbers');
    await call('load:replace', { _id: parents[0]._id, load: { shipmentId: 'SHIP-0', loadNumber: 'LOAD-1', carrierSCAC: 'ABCD' } });
    assert.equal((await f.db.counter.findById('signature-pad-checklist')).sequence, 6, 'Editing keeps the stored numbers');
    await call('load:sync', [{ poNumber: parents[1].poNumber, load: { shipmentId: 'SHIP-1', loadNumber: 'LOAD-2' } }]);
    const moved = await f.db.outbound.findById(parents[1]._id).lean();
    assert.notEqual(moved.loads[0].checklist.labeled.barcode, original[1].labeled.barcode);
    await assert.rejects(workflow.lookup(device, original[1].labeled.barcode), /workflowNotFound|workflowChanged/);
    await call('load:update', { shipmentId: 'SHIP-0', loadNumber: 'LOAD-3' });
    const edited = await f.db.outbound.findById(parents[0]._id).lean();
    assert.notEqual(edited.loads[0].checklist.picked.barcode, original[0].picked.barcode);
    assert.equal(edited.loads[0].checklist.picked.barcodeLoadNumber, 'LOAD-3');
    await assert.rejects(workflow.lookup(device, original[0].picked.barcode), /workflowNotFound/);
});

test('creation through import and outbound update fills codes before saving; old shipments receive them on sync', { skip: !uri }, async t => {
    const f = await loadSyncFixture(uri); t.after(() => f.close());
    const items = [{ styleCode: '1234', quantity: 120, casePack: 12 }];
    const first = await f.db.outbound.create({ poNumber: 'PO-001', items });
    assert.equal((await f.sync([{ poNumber: first.poNumber, load: { shipmentId: 'NEW', loadNumber: 'LOAD-1', items } }])).status, 'success');
    const imported = await f.db.outbound.findById(first._id).lean();
    assert.match(imported.loads[0].checklist.labeled.barcode, /^403\d{9}$/);
    const second = await f.db.outbound.create({ poNumber: 'PO-002', items,
        loads: [{ shipmentId: 'OLD', loadNumber: 'LOAD-2', checklist: { picked: { status: true, timestamp: new Date('2026-09-01') } } }] });
    assert.equal((await f.sync([{ poNumber: second.poNumber, load: { shipmentId: 'OLD', loadNumber: 'LOAD-2' } }])).status, 'success');
    const updated = await f.db.outbound.findById(second._id).lean();
    assert.match(updated.loads[0].checklist.picked.barcode, /^404\d{9}$/);
    assert.equal(updated.loads[0].checklist.picked.status, true);
    assert.equal(updated.loads[0].checklist.picked.timestamp.toISOString(), '2026-09-01T00:00:00.000Z');
    let result;
    await f.handlers['outbound:update']({ _id: second._id, loads: [...updated.loads, { shipmentId: 'EXTRA', loadNumber: 'LOAD-3', items }] }, response => { result = response; });
    assert.equal(result.status, 'success', result.message);
    const extra = await f.db.outbound.findById(second._id).lean();
    assert.match(extra.loads[1].checklist.inspected.barcode, /^402\d{9}$/);
});
