const assert = require('node:assert/strict');
const test = require('node:test');
const { randomUUID } = require('node:crypto');
const sharp = require('sharp');
const { loadSyncFixture } = require('./support/loadSyncFixture');
const { createBolDocumentService } = require('../utils/bolDocumentService');
const { createSignaturePadAccess } = require('../utils/signaturePadAccess');
const { attachBolDocuments, outboundBolPipeline } = require('../utils/bolDocuments');

const uri = process.env.DATA_SYNC_TEST_URI;
const integration = { skip: !uri };
const loadNumber = '77925000', number = '84017970842584717', barcode = `401${number}`;
const user = { _id: 'test-operator', role: 'Admin', status: 'Active' };
const image = sharp({ create: { width: 80, height: 20, channels: 4, background: '#142538' } }).png()
    .toBuffer().then(buffer => `data:image/png;base64,${buffer.toString('base64')}`);

const fixture = async t => {
    const f = await loadSyncFixture(uri);
    t.after(() => f.close());
    await f.db.outbound.collection.insertMany(Array.from({ length: 19 }, (_, index) => ({
        poNumber: `PO-${index}`, name: 'Test DC', address: '123 Test Road', city: 'Greenwood', state: 'SC', zip: '29646',
        loads: [{ shipmentId: `SHIP-${index}`, loadNumber, status: 'Loading', assignedSCAC: 'HBGI', cartons: 12, weight: 50, pallets: 1 }],
    })));
    const service = createBolDocumentService(f.db);
    const document = await service.save({ loadNumber, number });
    await f.db.hauler.create({ loadNumber, trailer: 'TEST-TRAILER', seal: 'TEST-SEAL' });
    const access = createSignaturePadAccess({ models: f.db, secret: 'test-only-signing-key', getUser: async () => user });
    const credential = await access.authorize(user, 'test-pad');
    const device = await access.authenticate(credential.token);
    return { ...f, access, device, service, document };
};

test('19 shipment references share SignPad generation, signatures, retries and reprints', integration, async t => {
    const f = await fixture(t);
    const shipments = await f.db.outbound.find().lean();
    assert.equal((await f.access.lookup(f.device, barcode, true, true)).needsGeneration, true);
    f.commands.length = 0;
    const prepared = await f.access.prepare(f.device, { barcode });
    assert.equal(prepared.copies, 19);
    assert.equal(prepared.requiresShipper, true);
    assert.equal(prepared.trailerNumber, 'TEST-TRAILER');
    assert.equal(f.commands.filter(command => command.name === 'update').length, 1);
    const generated = await f.service.get({ loadNumber });
    assert.equal(String(generated._id), String(f.document._id));
    assert.equal(generated.rawData.customer_order_info.length, 19);
    assert.equal(generated.rawData.grand_totals.customer_order_info.pkgs, 228);
    assert.equal(generated.rawData.seal_number, 'TEST-SEAL');
    assert.equal(generated.revision, f.document.revision + 1);

    const input = { grant: prepared.grant, submissionId: randomUUID(), image: await image, shipperImage: await image };
    f.commands.length = 0;
    const receipt = await f.access.sign(f.device, input);
    assert.equal(f.commands.filter(command => command.name === 'update').length, 1);
    const signed = await f.service.get({ loadNumber });
    assert.equal(signed.revision, generated.revision + 1);
    assert.equal(signed.rawData.driver_signature, input.image);
    assert.equal(signed.rawData.shipper_signature, input.shipperImage);
    assert.equal(signed.rawData.driver_signature_submission_id, input.submissionId);
    assert.equal(signed.rawData.shipper_signature_submission_id, input.submissionId);
    assert.deepEqual(await f.db.outbound.find().lean(), shipments, 'Signing never rewrites shipments');
    assert.equal(await f.db.bolDocument.countDocuments(), 1);

    f.commands.length = 0;
    assert.deepEqual(await f.access.sign(f.device, input), receipt, 'Lost acknowledgments reuse the same receipt');
    assert.equal(f.commands.filter(command => command.name === 'update').length, 0);
    await assert.rejects(f.service.save({ loadNumber, rawData: generated.rawData, revision: generated.revision }), /bolChanged/);
    await assert.rejects(f.service.save({ loadNumber, rawData: generated.rawData }), /alreadySigned/);
    const rows = await attachBolDocuments(f.db, await f.db.outbound.find().lean(), { full: true });
    assert.ok(rows.every(row => row.loads[0].bolDocument.rawData.driver_signature === input.image));
    const summaries = await f.db.outbound.aggregate(outboundBolPipeline());
    assert.ok(summaries.every(row => row.loads[0].bolSummary.revision === signed.revision));
    assert.ok(summaries.every(row => !Object.hasOwn(row.loads[0], 'bol') && !row.loads[0].bolSummary.rawData));

    const request = { deviceId: f.device._id, grant: prepared.grant, submissionId: input.submissionId };
    assert.deepEqual((await f.access.printData(user, request)).bol, signed.rawData);
    const reprint = await f.access.lookup(f.device, barcode, true);
    assert.equal(reprint.signed, true);
    assert.deepEqual((await f.access.printData(user, { ...request, grant: reprint.grant })).bol, signed.rawData);
});

test('a failed SignPad transaction rolls back both signatures and revision before retry', integration, async t => {
    const f = await fixture(t);
    const prepared = await f.access.prepare(f.device, { barcode });
    const before = await f.service.get({ loadNumber });
    const input = { grant: prepared.grant, submissionId: randomUUID(), image: await image, shipperImage: await image };
    const update = f.db.bolDocument.updateOne;
    f.db.bolDocument.updateOne = async (...args) => {
        await update.apply(f.db.bolDocument, args);
        throw new Error('Failure after document write');
    };
    try { await assert.rejects(f.access.sign(f.device, input), /Failure after document write/); }
    finally { f.db.bolDocument.updateOne = update; }
    assert.deepEqual(await f.service.get({ loadNumber }), before);
    assert.equal(await f.db.outbound.countDocuments({ 'loads.bolId': before._id }), 19);
    await f.access.sign(f.device, input);
    assert.equal((await f.service.get({ loadNumber })).revision, before.revision + 1);
});

test('concurrent SignPads cannot overwrite the winner on a shared document', integration, async t => {
    const f = await fixture(t);
    const first = await f.access.prepare(f.device, { barcode });
    const otherDevice = { _id: 'other-test-pad' };
    const second = await f.access.lookup(otherDevice, barcode, true, true);
    const inputs = await Promise.all([first, second].map(async document => ({
        grant: document.grant, submissionId: randomUUID(), image: await image, shipperImage: await image,
    })));
    const results = await Promise.allSettled([f.access.sign(f.device, inputs[0]), f.access.sign(otherDevice, inputs[1])]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.match(results.find(result => result.status === 'rejected').reason.message, /alreadySigned/);
    const winner = results.findIndex(result => result.status === 'fulfilled');
    const saved = await f.service.get({ loadNumber });
    assert.equal(saved.rawData.driver_signature_submission_id, inputs[winner].submissionId);
    assert.equal(saved.rawData.shipper_signature_submission_id, inputs[winner].submissionId);
    assert.equal(saved.revision, f.document.revision + 2);
});
