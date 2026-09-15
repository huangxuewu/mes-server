const assert = require('node:assert/strict');
const test = require('node:test');
const { loadSyncFixture } = require('./support/loadSyncFixture');
const { createBolDocumentService } = require('../utils/bolDocumentService');
const uri = process.env.DATA_SYNC_TEST_URI;

test('BOL cache sync batches metadata and transfers only changed standalone documents', { skip: !uri }, async t => {
    const f = await loadSyncFixture(uri);
    t.after(() => f.close());
    const service = createBolDocumentService(f.db);
    const first = await f.db.bolDocument.create({ loadNumber: 'L1', number: 'B1', revision: 3, rawData: { note: 'body' } });
    await f.db.bolDocument.create({ loadNumber: '', shipmentId: 'S1', number: 'B2', revision: 1, rawData: { note: 'unnumbered' } });
    const known = { loadNumber: 'L1', documentId: String(first._id), revision: first.revision, updatedAt: first.updatedAt.toISOString() };
    f.commands.length = 0;
    const unchanged = await service.sync({ targets: [known] });
    assert.deepEqual(unchanged, [{ unchanged: true }]);
    assert.equal(f.commands.filter(entry => entry.name === 'find').length, 1);
    assert.equal(f.commands[0].command.find, 'bolDocument');
    assert.ok(!f.commands[0].command.projection.rawData);
    const result = await service.sync({ targets: [{ loadNumber: 'L1' }, { loadNumber: 'L1' }, { shipmentId: 'S1' }, { loadNumber: 'MISSING' }] });
    assert.equal(result[0].document.rawData.note, 'body');
    assert.equal(String(result[1].document._id), String(first._id));
    assert.equal(result[2].document.rawData.note, 'unnumbered');
    assert.equal(result[3].document, null);
    await f.db.bolDocument.updateOne({ _id: first._id }, { $set: { 'rawData.note': 'edited' }, $inc: { revision: 1 } });
    assert.equal((await service.sync({ targets: [known] }))[0].document.rawData.note, 'edited');
    await f.db.bolDocument.deleteOne({ _id: first._id });
    assert.equal((await service.sync({ targets: [known] }))[0].document, null);
    const replacement = await f.db.bolDocument.create({ loadNumber: 'L1', number: 'B1', revision: 1 });
    assert.equal(String((await service.sync({ targets: [known] }))[0].document._id), String(replacement._id));
    assert.ok(f.commands.filter(entry => entry.name === 'find').every(entry => entry.command.find === 'bolDocument'));
});

test('BOL cache sync rejects unbounded or malformed identities before querying', async () => {
    const service = createBolDocumentService({ bolDocument: { find: assert.fail } });
    for (const targets of [null, Array(21).fill({ loadNumber: 'L1' }), [{}], [{ loadNumber: { $ne: null } }], [null]])
        await assert.rejects(service.sync({ targets }), /Invalid/);
    assert.deepEqual(await service.sync({ targets: [] }), []);
});

test('a desktop draft cannot overwrite a replacement BOL with the same revision', { skip: !uri }, async t => {
    const f = await loadSyncFixture(uri);
    t.after(() => f.close());
    const service = createBolDocumentService(f.db);
    await f.db.outbound.create({ poNumber: 'PO1', loads: [{ loadNumber: 'L1', shipmentId: 'S1', status: 'Loading' }] });
    const first = await service.save({ loadNumber: 'L1', rawData: { bill_of_lading_number: 'B1' } });
    await f.db.bolDocument.deleteOne({ _id: first._id });
    const replacement = await f.db.bolDocument.create({ loadNumber: 'L1', number: 'B1', revision: first.revision, rawData: { note: 'replacement' } });
    await f.db.outbound.updateOne({ poNumber: 'PO1' }, { $set: { 'loads.0.bolId': replacement._id } });
    await assert.rejects(service.save({ loadNumber: 'L1', documentId: String(first._id), revision: first.revision, rawData: { note: 'stale draft' } }), /bolChanged/);
    await assert.rejects(service.save({ loadNumber: 'L1', documentId: null, rawData: { note: 'assumed missing' } }), /bolChanged/);
    assert.equal((await service.get({ loadNumber: 'L1' })).rawData.note, 'replacement');
});
