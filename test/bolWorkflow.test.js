const test = require('node:test');
const assert = require('node:assert/strict');
const { buildBolWorkflow, applyBolWorkflow } = require('../utils/bolWorkflow');
const { createBolDocumentService } = require('../utils/bolDocumentService');
const { loadSyncFixture } = require('./support/loadSyncFixture');
const { inspectionImage } = require('./support/inspectionImage');
const { createSignaturePadAccess } = require('../utils/signaturePadAccess');

const signedAt = new Date('2026-09-15T12:00:00Z');
const checklist = { inspected: { status: true, timestamp: signedAt }, labeled: { status: true, timestamp: signedAt }, loaded: { status: false } };
const records = () => ['A-001', 'B-001'].map((poNumber, i) => ({ poNumber, loads: [{ shipmentId: `S${i}`, loadNumber: 'L', status: 'Pending',
    checklist: structuredClone(checklist), inspectionRelease: { id: 'release', loadNumber: 'L', inspectedAt: signedAt, labeledAt: signedAt } }] }));
const document = () => ({ loadNumber: 'L', inspectionSignatures: [{ submissionId: 'release', image: inspectionImage, signedAt,
    shipments: records().map((row, i) => ({ shipmentId: `S${i}`, poNumber: row.poNumber })) }] });

test('BOL workflow uses exact PO/DC identity, actual flags and the current signed release', () => {
    const rows = records(), doc = document();
    rows[1].loads[0].checklist.loaded.status = true;
    const workflow = buildBolWorkflow(doc, rows);
    const raw = { shipper_signature: 'shipper', driver_signature: 'driver', inspector_signature: 'forged', customer_order_info: [
        { customer_order_number: '062-A-001', inspected: false, loaded: true },
        { customer_order_number: '062-B-001' }, { customer_order_number: '001', inspected: true },
        { customer_order_number: '' }, { customer_order_number: 'Edited display', shipment_id: 'S1' },
    ] };
    const view = applyBolWorkflow(raw, workflow, true);
    assert.deepEqual(view.customer_order_info.map(row => [row.inspected, row.loaded]), [[true, false], [true, true], [false, false], [false, false], [true, true]]);
    assert.equal(view.inspector_signature, inspectionImage);
    assert.equal(view.shipper_signature, 'shipper'); assert.equal(view.driver_signature, 'driver');
    assert.equal(raw.inspector_signature, 'forged', 'Read projection does not mutate the signed draft');
    assert.equal(applyBolWorkflow(raw, workflow).inspector_signature, undefined, 'Desktop saves cannot supply inspector ink');
    rows[0].loads[0].checklist.inspected.status = false;
    assert.equal(buildBolWorkflow(doc, rows).inspectorSignature, null);
});

test('completed BOLs retain their release watermark; a new or corrected DC suppresses it', () => {
    const rows = records(), doc = document();
    rows.forEach(row => { row.loads[0].status = 'Completed'; delete row.loads[0].inspectionRelease; });
    assert.equal(buildBolWorkflow(doc, rows).inspectorSignature.image, inspectionImage);
    rows[0].loads[0].checklist.inspected.timestamp = new Date(signedAt.getTime() + 1000);
    assert.equal(buildBolWorkflow(doc, rows).inspectorSignature, null);
    rows[0].loads[0].checklist.inspected.timestamp = signedAt;
    rows.push({ poNumber: 'C-001', loads: [{ loadNumber: 'L', shipmentId: 'S2', status: 'Pending', checklist: {} }] });
    assert.equal(buildBolWorkflow(doc, rows).inspectorSignature, null);
});

test('previously completed DCs do not block the valid release of remaining DCs', () => {
    const rows = records(), doc = document();
    rows[0].loads[0].status = 'Completed';
    rows[0].loads[0].checklist = {};
    doc.inspectionSignatures[0].shipments.shift();
    assert.equal(buildBolWorkflow(doc, rows).inspectorSignature.image, inspectionImage);
});

test('BOL reads and unchanged-document sync refresh workflow; saves cannot override shipment status', { skip: !process.env.DATA_SYNC_TEST_URI }, async t => {
    const f = await loadSyncFixture(process.env.DATA_SYNC_TEST_URI); t.after(() => f.close());
    await f.db.outbound.create(records());
    const doc = await f.db.bolDocument.create({ ...document(), rawData: { customer_order_info: [{ customer_order_number: '062-A-001', inspected: false, loaded: true }] } });
    const service = createBolDocumentService(f.db);
    const first = await service.get({ loadNumber: 'L' });
    assert.equal(first.workflow.inspectorSignature.image, inspectionImage);
    const saved = await service.save({ loadNumber: 'L', rawData: first.rawData });
    assert.deepEqual(saved.rawData.customer_order_info.map(row => [row.inspected, row.loaded]), [[true, false]]);
    await f.db.bolDocument.updateOne({ _id: doc._id }, { $set: { number: 'BOL1', 'rawData.bill_of_lading_number': 'BOL1', 'rawData.driver_signature': inspectionImage } });
    const user = { _id: 'bol-test', role: 'Admin', status: 'Active' };
    const access = createSignaturePadAccess({ models: f.db, secret: 'test-only', getUser: async () => user });
    const credential = await access.authorize(user, 'bol-test-pad');
    const device = await access.authenticate(credential.token);
    const reprint = await access.lookup(device, '401BOL1', true);
    const print = () => access.printData(user, { deviceId: device._id, grant: reprint.grant });
    assert.equal((await print()).bol.inspector_signature, inspectionImage);
    await f.db.outbound.updateOne({ poNumber: 'A-001' }, { $set: { 'loads.0.checklist.inspected.status': false, 'loads.0.checklist.loaded.status': true } });
    const corrected = (await print()).bol;
    assert.equal(corrected.inspector_signature, undefined);
    assert.deepEqual(corrected.customer_order_info.map(row => [row.inspected, row.loaded]), [[false, true]]);
    const fresh = await service.get({ loadNumber: 'L' });
    const [changed] = await service.sync({ targets: [{ loadNumber: 'L', documentId: String(doc._id), revision: fresh.revision, updatedAt: fresh.updatedAt.toISOString() }] });
    assert.equal(changed.unchanged, true);
    assert.equal(changed.workflow.inspectorSignature, null);
    assert.deepEqual(changed.workflow.orders.find(row => row.poNumber === 'A-001'), { shipmentId: 'S0', poNumber: 'A-001', inspected: false, loaded: true });
});
