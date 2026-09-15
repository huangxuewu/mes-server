const test = require('node:test');
const assert = require('node:assert/strict');
const { loadSyncFixture } = require('./support/loadSyncFixture');
const { createSignaturePadWorkflow } = require('../utils/signaturePadWorkflow');
const { createOutboundWorkflowState } = require('../utils/outboundWorkflowState');
const { getMilestones } = require('../utils/outboundWorkflowState');
const { inspectionImage } = require('./support/inspectionImage');
const uri = process.env.DATA_SYNC_TEST_URI;

const setup = async t => {
    const f = await loadSyncFixture(uri); t.after(() => f.close());
    const items = [{ styleCode: 'STYLE', quantity: 120, casePack: 12 }];
    const parents = await f.db.outbound.create([1, 2].map(i => ({ poNumber: 'PO-00' + i, items,
        loads: [{ shipmentId: 'S' + i, loadNumber: 'LOAD', status: 'Pending', carrierSCAC: 'ABCD', items }] })));
    const workflow = createSignaturePadWorkflow({ models: f.db, secret: 'workflow-integration-test' });
    const state = createOutboundWorkflowState(f.db);
    const device = { _id: 'pad-one' };
    const lookup = code => workflow.lookup(device, code, 3);
    const confirm = (grant, shipmentIds) => workflow.confirm(device, { grant, shipmentIds, image: inspectionImage });
    const call = async (name, payload) => { let result; await f.handlers[name](payload, value => { result = value; }); return result; };
    const rows = async () => (await f.db.outbound.find().sort({ poNumber: 1 }).lean()).flatMap(row => row.loads);
    return { ...f, parents, workflow, state, device, lookup, confirm, call, rows };
};

test('five stages, concurrent inspections, dynamic slip action and durable notification replay', { skip: !uri }, async t => {
    const f = await setup(t);
    const blocked = await f.lookup('402LOAD');
    assert.equal(blocked.available, false);
    await assert.rejects(f.confirm(blocked.grant, ['S1']), /labelingRequired/);
    assert.equal((await f.call('load:update', { shipmentId: 'S1', checklist: { loaded: { status: true } } })).status, 'error');
    await f.confirm((await f.lookup('403LOAD|S1')).grant, ['S1']);
    assert.equal((await f.state.notifications(0)).events.length, 0);
    assert.equal((await f.call('load:update', { shipmentId: 'S2', checklist: { labeled: { status: true, timestamp: new Date() } } })).status, 'success');
    const labeled = await f.state.notifications(0);
    assert.deepEqual(labeled.events.map(row => row.stage), ['labeled']);
    const stale = await f.lookup('403LOAD|S1');
    const a = await f.lookup('402LOAD'), b = await f.lookup('402LOAD');
    await Promise.all([f.confirm(a.grant, ['S1']), f.confirm(b.grant, ['S2'])]);
    await f.confirm(a.grant, ['S1']);
    assert.equal(await f.db.signaturePadNotification.countDocuments({ stage: 'inspected' }), 0);
    assert.equal((await f.lookup('403LOAD|S1')).action, 'labeled');
    await f.confirm((await f.lookup('402LOAD')).grant, ['S1', 'S2']);
    assert.equal(await f.db.signaturePadNotification.countDocuments({ stage: 'inspected' }), 1);
    await assert.rejects(f.confirm(stale.grant, ['S1']), /workflowChanged/);
    await assert.rejects(f.workflow.lookup(f.device, '403LOAD|S1'), /updateRequired/);
    const loading = await f.lookup('403LOAD|S1');
    assert.equal(loading.action, 'loaded');
    const first = await f.confirm(loading.grant, ['S1']);
    assert.deepEqual(await f.confirm(loading.grant, ['S1']), first);
    const secondPad = createOutboundWorkflowState(f.db);
    assert.deepEqual(await secondPad.notifications(0), await f.state.notifications(0), 'Each pad has its own cursor, including after service restart');
    const received = await f.state.notifications(labeled.cursor);
    assert.deepEqual(received.events.map(row => row.stage), ['inspected']);
    assert.equal((await f.state.notifications(received.cursor)).events.length, 0);
    assert.match((await f.call('load:update', { shipmentId: 'S1', checklist: { inspected: { status: false } } })).message, /undoLoadedFirst/);
    assert.equal((await f.call('load:update', { shipmentId: 'S1', checklist: { loaded: { status: false, timestamp: null } } })).status, 'success');
    assert.equal((await f.call('load:update', { shipmentId: 'S1', checklist: { inspected: { status: false, timestamp: null } } })).status, 'success');
    assert.equal((await f.state.notifications(labeled.cursor)).events.length, 0, 'Outdated inspection alert is suppressed');
    assert.match((await f.call('load:update', { shipmentId: 'S2', checklist: { loaded: { status: true } } })).message, /inspectionRequired/);
    await f.confirm((await f.lookup('402LOAD')).grant, ['S1']);
    await f.confirm((await f.lookup('402LOAD')).grant, ['S1', 'S2']);
    const again = await f.state.notifications(received.cursor);
    assert.equal(again.events.length, 1);
    assert.equal(again.events[0].stage, 'inspected');
    assert.ok(again.cursor > received.cursor);
    await f.db.signaturePadNotification.updateMany({}, { $set: { expiresAt: new Date(0) } });
    assert.equal((await f.state.notifications(0)).events.length, 0);
});

test('inspection seal is UI-only, desktop cannot grant inspection, and baseline sends no old alerts', { skip: !uri }, async t => {
    const f = await setup(t);
    await f.db.outbound.updateMany({}, { $set: { 'loads.0.checklist.labeled.status': true, 'loads.0.checklist.inspected.status': true } });
    await f.state.reconcile();
    assert.equal(await f.db.signaturePadNotification.countDocuments(), 0);
    assert.equal((await f.call('load:update', { shipmentId: 'S1', checklist: { labeled: { status: false } } })).status, 'success', 'No server-side seal restriction');
    assert.equal((await f.lookup('402LOAD')).available, false);
    assert.equal((await f.call('load:update', { shipmentId: 'S1', inspectionRelease: { id: 'forged' } })).status, 'error');
    assert.equal((await f.call('loads:update', { loadNumber: 'LOAD', 'inspectionRelease.id': 'forged' })).status, 'error');
    assert.equal((await f.call('load:update', { shipmentId: 'S1', checklist: { inspected: { status: false } } })).status, 'success');
    for (const status of [true, 'true'])
        assert.equal((await f.call('load:update', { shipmentId: 'S1', checklist: { inspected: { status } } })).status, 'error');
    const rows = await f.rows();
    assert.equal(rows[0].checklist.labeled.status, false);
    assert.equal(rows[1].checklist.inspected.status, true);
});

test('parcel loading completes the shipment and updates the order; cancelled DCs do not block readiness', { skip: !uri }, async t => {
    const f = await setup(t);
    await f.db.outbound.updateOne({ _id: f.parents[1]._id }, { $set: { 'loads.0.status': 'Cancelled' } });
    await f.db.outbound.updateOne({ _id: f.parents[0]._id }, { $set: { 'loads.0.carrierSCAC': 'DMSP',
        'loads.0.checklist.labeled.status': true, 'loads.0.checklist.inspected.status': true } });
    await f.confirm((await f.lookup('402LOAD')).grant, ['S1']);
    let updated = 0;
    f.db.order.updateShipmentStatus = async () => { updated++; };
    const loaded = await f.lookup('403LOAD|S1');
    const first = await f.confirm(loaded.grant, ['S1']);
    assert.equal((await f.rows())[0].status, 'Completed');
    assert.deepEqual(await f.confirm(loaded.grant, ['S1']), first, 'Parcel confirmation retries survive the automatic closure');
    assert.equal(updated, 2);
    assert.equal((await f.state.notifications(0)).events.length, 0);
    await assert.rejects(f.lookup('402LOAD'), /workflowClosed/);
});

test('authenticated long polling wakes for completion and stops when authorization is revoked', { skip: !uri }, async t => {
    const f = await setup(t);
    const express = require('express');
    const { createHash } = require('node:crypto');
    const token = 'b'.repeat(64);
    await f.db.signaturePadDevice.create({ _id: 'test-pad', ownerId: 'test-owner', tokenHash: createHash('sha256').update(token).digest('hex') });
    f.db.user = { findById: () => ({ lean: async () => ({ _id: 'test-owner', status: 'Active', role: 'User', permission: { module: ['office'] } }) }) };
    const app = express(); app.use('/signature-pad', require('../routes/signaturePad')(f.db));
    const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    const poll = (after = 0) => fetch(`http://127.0.0.1:${server.address().port}/signature-pad/notifications/poll`, {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ after }),
    });
    assert.equal((await poll(-1)).status, 400);
    const pending = poll();
    await f.confirm((await f.lookup('403LOAD|S1')).grant, ['S1']);
    await f.confirm((await f.lookup('403LOAD|S2')).grant, ['S2']);
    const response = await pending;
    assert.equal(response.status, 200);
    const { payload } = await response.json();
    assert.deepEqual(payload.events.map(row => row.stage), ['labeled']);
    const revoked = poll(payload.cursor);
    await f.db.signaturePadDevice.updateOne({ _id: 'test-pad' }, { $set: { revoked: true } });
    assert.equal((await revoked).status, 401);
});


test('desktop parcel Loaded can complete after inspection without excluding itself from the prerequisite check', { skip: !uri }, async t => {
    const f = await setup(t);
    await f.db.outbound.updateMany({}, { $set: { 'loads.0.carrierSCAC': 'DMSP',
        'loads.0.checklist.labeled.status': true, 'loads.0.checklist.inspected.status': true } });
    await f.confirm((await f.lookup('402LOAD')).grant, ['S1', 'S2']);
    const result = await f.call('load:update', { shipmentId: 'S1', status: 'Completed', checklist: { loaded: { status: true } } });
    assert.equal(result.status, 'success', result.message);
    assert.equal((await f.rows())[0].status, 'Completed');
});

test('per-DC inspection remains unsigned; the final signature releases every DC and stays private on the BOL', { skip: !uri }, async t => {
    const f = await setup(t);
    await f.db.outbound.updateMany({}, { $set: { 'loads.0.checklist.labeled.status': true } });
    const rawData = { bill_of_lading_number: '401123', shipper_signature: 'existing shipper', driver_signature: 'existing driver' };
    const document = await f.db.bolDocument.create({ loadNumber: 'LOAD', number: '401123', rawData });
    await assert.rejects(f.workflow.lookup(f.device, '402LOAD', 2), /updateRequired/);
    const first = await f.lookup('402LOAD');
    const partial = await f.workflow.confirm(f.device, { grant: first.grant, shipmentIds: ['S1'] });
    assert.equal(partial.releaseRequired, false);
    assert.equal((await f.db.bolDocument.findById(document._id).lean()).inspectionSignatures.length, 0);
    const last = await f.workflow.confirm(f.device, { grant: first.grant, shipmentIds: ['S2'] });
    assert.equal(last.releaseRequired, true);
    assert.equal((await f.lookup('403LOAD|S1')).action, 'labeled');
    const inspectionTimes = (await f.rows()).map(row => row.checklist.inspected.timestamp);
    const { grant, action } = await f.lookup('402LOAD');
    assert.equal(action, 'released');
    const shipmentIds = ['S1', 'S2'];
    await assert.rejects(f.workflow.confirm(f.device, { grant, shipmentIds }), /inspectorSignatureRequired/);
    const blank = 'data:image/png;base64,' + (await require('sharp')({ create: { width: 60, height: 20, channels: 4, background: '#ffffff' } }).png().toBuffer()).toString('base64');
    await assert.rejects(f.workflow.confirm(f.device, { grant, shipmentIds, image: blank }), /invalidImage/);
    await assert.rejects(f.confirm(grant, ['S1']), /inspectionRequired/);
    assert.equal(getMilestones(await f.rows()).released, false);
    const receipt = await f.confirm(grant, shipmentIds);
    assert.deepEqual(await f.confirm(grant, shipmentIds), receipt);
    assert.equal((await f.lookup('403LOAD|S1')).action, 'loaded');
    assert.deepEqual((await f.rows()).map(row => row.checklist.inspected.timestamp), inspectionTimes, 'Release does not change any PO inspection timestamp');
    const saved = await f.db.bolDocument.findById(document._id).lean();
    assert.deepEqual(saved.rawData, rawData, 'Inspector signature never enters the printed BOL fields');
    assert.equal(saved.inspectionSignatures.length, 1);
    const signature = saved.inspectionSignatures[0];
    assert.equal(signature.image, inspectionImage);
    assert.equal(signature.deviceId, f.device._id);
    assert.equal(signature.signedAt.toISOString(), receipt.shipments[0].timestamp.toISOString());
    assert.deepEqual(signature.shipments.map(row => row.shipmentId), shipmentIds);
    assert.ok((await f.rows()).every(row => String(row.bolId) === String(document._id)));
    const otherImage = 'data:image/png;base64,' + (await require('sharp')({ create: { width: 30, height: 30, channels: 4, background: '#222222' } }).png().toBuffer()).toString('base64');
    await assert.rejects(f.workflow.confirm(f.device, { grant, shipmentIds, image: otherImage }), /workflowChanged/);
    assert.equal((await f.lookup('402LOAD')).available, false);
    const previousLoadReview = await f.lookup('403LOAD|S2');
    await f.call('load:update', { shipmentId: 'S1', checklist: { inspected: { status: false, timestamp: null } } });
    assert.ok((await f.rows()).every(row => !row.inspectionRelease?.id));
    assert.equal((await f.lookup('403LOAD|S2')).action, 'labeled');
    await f.confirm((await f.lookup('402LOAD')).grant, ['S1']);
    assert.equal(getMilestones(await f.rows()).released, false);
    await f.confirm((await f.lookup('402LOAD')).grant, shipmentIds);
    const again = await f.db.bolDocument.findById(document._id).lean();
    assert.equal(again.inspectionSignatures.length, 2, 'Releasing again preserves the previous signature as history');
    assert.deepEqual(again.inspectionSignatures[0], signature);
    await assert.rejects(f.confirm(previousLoadReview.grant, ['S2']), /workflowChanged/, 'Loading review is bound to its signed release');
});

test('BOL edits or corrected inspections invalidate release review and failed release saves roll back the signature', { skip: !uri }, async t => {
    const f = await setup(t);
    await f.db.outbound.updateMany({}, { $set: { 'loads.0.checklist.labeled.status': true, 'loads.0.checklist.inspected.status': true } });
    const stale = await f.lookup('402LOAD');
    await f.db.bolDocument.create({ loadNumber: 'LOAD', number: '401999', rawData: { bill_of_lading_number: '401999' } });
    await assert.rejects(f.confirm(stale.grant, ['S1', 'S2']), /workflowChanged/);
    const corrected = await f.lookup('402LOAD');
    await f.call('load:update', { shipmentId: 'S1', checklist: { inspected: { status: false } } });
    await f.confirm((await f.lookup('402LOAD')).grant, ['S1']);
    await assert.rejects(f.confirm(corrected.grant, ['S1', 'S2']), /workflowChanged/);
    const reviewed = await f.lookup('402LOAD');
    const update = f.db.outbound.updateOne;
    f.db.outbound.updateOne = async () => { throw new Error('Simulated shipment failure'); };
    await assert.rejects(f.confirm(reviewed.grant, ['S1', 'S2']), /Simulated shipment failure/);
    f.db.outbound.updateOne = update;
    assert.equal((await f.db.bolDocument.findOne({ loadNumber: 'LOAD' }).lean()).inspectionSignatures.length, 0);
    assert.equal(getMilestones(await f.rows()).released, false);
    await f.confirm(reviewed.grant, ['S1', 'S2']);
    const { createBolDocumentService } = require('../utils/bolDocumentService');
    const service = createBolDocumentService(f.db);
    const before = await service.get({ loadNumber: 'LOAD' });
    await service.save({ loadNumber: 'LOAD', rawData: { bill_of_lading_number: '401999', trailer: 'T123' } });
    assert.deepEqual((await service.get({ loadNumber: 'LOAD' })).inspectionSignatures, before.inspectionSignatures);
    await service.save({ loadNumber: 'LOAD', clear: true });
    const cleared = await service.get({ loadNumber: 'LOAD' });
    assert.equal(cleared.rawData, null);
    assert.deepEqual(cleared.inspectionSignatures, before.inspectionSignatures, 'Clearing the printable draft retains historical release evidence');
});
