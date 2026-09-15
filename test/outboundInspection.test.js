const test = require('node:test');
const assert = require('node:assert/strict');
const { loadSyncFixture } = require('./support/loadSyncFixture');
const { createSignaturePadWorkflow } = require('../utils/signaturePadWorkflow');
const { createOutboundWorkflowState } = require('../utils/outboundWorkflowState');
const uri = process.env.DATA_SYNC_TEST_URI;

const setup = async t => {
    const f = await loadSyncFixture(uri); t.after(() => f.close());
    const items = [{ styleCode: 'STYLE', quantity: 120, casePack: 12 }];
    const parents = await f.db.outbound.create([1, 2].map(i => ({ poNumber: 'PO-00' + i, items,
        loads: [{ shipmentId: 'S' + i, loadNumber: 'LOAD', status: 'Pending', carrierSCAC: 'ABCD', items }] })));
    const workflow = createSignaturePadWorkflow({ models: f.db, secret: 'workflow-integration-test' });
    const state = createOutboundWorkflowState(f.db);
    const device = { _id: 'pad-one' };
    const lookup = code => workflow.lookup(device, code, 2);
    const confirm = (grant, shipmentIds) => workflow.confirm(device, { grant, shipmentIds });
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
    const result = await f.call('load:update', { shipmentId: 'S1', status: 'Completed', checklist: { loaded: { status: true } } });
    assert.equal(result.status, 'success', result.message);
    assert.equal((await f.rows())[0].status, 'Completed');
});
