const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadSyncFixture } = require('./support/loadSyncFixture');
const { createBolDocumentService } = require('../utils/bolDocumentService');
const { outboundBolPipeline } = require('../utils/bolDocuments');
const { inspectBolMigration, migrateBolDocuments, verifyBolMigration } = require('../scripts/migrate-bol-documents');
const uri = process.env.DATA_SYNC_TEST_URI;
const integration = { skip: !uri };
const fixture = async (t, count = 19) => {
    const f = await loadSyncFixture(uri);
    t.after(() => f.close());
    await f.db.outbound.collection.insertMany(Array.from({ length: count }, (_, index) => ({ poNumber: `PO-${index}`,
        loads: [{ shipmentId: `SHIP-${index}`, loadNumber: '77925000', status: 'Loading' }] })));
    return { ...f, service: createBolDocumentService(f.db) };
};
const raw = { load_number: '77925000', bill_of_lading_number: '84017970842584717', shipper_signature: '', driver_signature: '', note: 'original' };

test('nineteen POs reference one BOL and later saves write only the shared document', integration, async t => {
    const f = await fixture(t);
    const created = await f.service.save({ loadNumber: '77925000', rawData: raw });
    const records = await f.db.outbound.find().lean();
    assert.ok(records.every(row => String(row.loads[0].bolId) === String(created._id) && !Object.hasOwn(row.loads[0], 'bol')));
    assert.equal(await f.db.bolDocument.countDocuments(), 1);
    f.commands.length = 0;
    const saved = await f.service.save({ loadNumber: '77925000', rawData: { ...raw, note: 'edited' }, revision: created.revision });
    assert.equal(saved.revision, created.revision + 1);
    assert.equal(f.commands.filter(command => ['update', 'findAndModify'].includes(command.name)).length, 1);
    assert.equal(saved.rawData.note, 'edited');
    const list = await f.db.outbound.aggregate(outboundBolPipeline());
    assert.ok(list.every(row => row.loads[0].bolSummary.number === raw.bill_of_lading_number && row.loads[0].bolSummary.hasRawData));
    assert.ok(list.every(row => !JSON.stringify(row).includes('shipper_signature')));
    assert.deepEqual((await f.service.get({ loadNumber: '77925000' })).rawData, saved.rawData);
});

test('stale revisions and signed drafts cannot overwrite the shared BOL', integration, async t => {
    const f = await fixture(t);
    const created = await f.service.save({ loadNumber: '77925000', rawData: raw });
    const signed = { ...raw, driver_signature: 'signed', driver_signature_submission_id: 'phone-submission' };
    await f.db.bolDocument.updateOne({ _id: created._id }, { $set: { rawData: signed }, $inc: { revision: 1 } });
    await assert.rejects(f.service.save({ loadNumber: '77925000', rawData: raw, revision: created.revision }), /bolChanged/);
    await assert.rejects(f.service.save({ loadNumber: '77925000', rawData: raw }), /alreadySigned/);
    assert.deepEqual((await f.service.get({ loadNumber: '77925000' })).rawData, signed);
});

test('a failed reference assignment rolls back the new document and all shipments', integration, async t => {
    const f = await fixture(t);
    const update = f.db.outbound.updateMany;
    f.db.outbound.updateMany = () => { throw new Error('Reference assignment failed'); };
    await assert.rejects(f.service.save({ loadNumber: '77925000', rawData: raw }), /Reference assignment failed/);
    f.db.outbound.updateMany = update;
    assert.equal(await f.db.bolDocument.countDocuments(), 0);
    assert.equal(await f.db.outbound.countDocuments({ 'loads.bolId': { $ne: null } }), 0);
    assert.ok(await f.service.save({ loadNumber: '77925000', rawData: raw }));
});

test('concurrent document edits with the same revision produce one winner', integration, async t => {
    const f = await fixture(t);
    const created = await f.service.save({ loadNumber: '77925000', rawData: raw });
    const results = await Promise.allSettled(['first', 'second'].map(note => f.service.save({loadNumber:'77925000', rawData:{...raw,note},revision:created.revision})));
    assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
    assert.equal(results.filter(result=>result.status==='rejected').length,1);
    assert.match(results.find(result=>result.status==='rejected').reason.message,/bolChanged/);
    assert.equal((await f.service.get({loadNumber:'77925000'})).revision,created.revision+1);
});

test('PDF linking completes selected shipments and leaves unshipped POs detached', integration, async t => {
    const f = await fixture(t, 3);
    await f.service.save({ loadNumber: '77925000', rawData: raw });
    const document = await f.service.save({ loadNumber: '77925000', url: 'https://example.test/bol.pdf', shipmentIds: ['SHIP-0', 'SHIP-1'] });
    const rows = await f.db.outbound.find().sort({ poNumber: 1 }).lean();
    assert.equal(rows[0].loads[0].status, 'Completed');
    assert.equal(rows[1].loads[0].status, 'Completed');
    assert.equal(rows[2].loads[0].status, 'Leftover, Reschedule Needed');
    assert.equal(rows[2].loads[0].bolId, null);
    await f.service.save({ loadNumber: '77925000', clear: true, revision: document.revision });
    const cleared = await f.service.get({ loadNumber: '77925000' });
    assert.equal(cleared.rawData, null);
    assert.equal(cleared.url, null);
    assert.equal(cleared.number, raw.bill_of_lading_number);
    assert.equal((await f.db.outbound.findOne({ poNumber: 'PO-0' }).lean()).loads[0].status, 'Picked Up');
});

test('migration dry-run is read-only and conflicting BOLs prevent all writes', integration, async t => {
    const f = await fixture(t, 2);
    await f.db.outbound.collection.updateMany({}, { $set: { 'loads.0.bol': { number: raw.bill_of_lading_number, rawData: raw } } });
    await f.db.outbound.collection.updateOne({ poNumber: 'PO-1' }, { $set: { 'loads.0.bol.number': 'OTHER' } });
    const inspection = await inspectBolMigration(f.connection.db);
    assert.equal(inspection.report.conflicts.length, 1);
    assert.equal((await migrateBolDocuments({ connection: f.connection, inspection })).applied, 0);
    await assert.rejects(migrateBolDocuments({ connection: f.connection, inspection, apply: true, backupPath: 'unused' }), /Migration stopped/);
    assert.equal(await f.db.bolDocument.countDocuments(), 0);
    assert.equal(await f.db.outbound.collection.countDocuments({ 'loads.bol': { $exists: true } }), 2);
});

test('migration creates one referenced document, preserves source data in backups, and is rerunnable', integration, async t => {
    const f = await fixture(t);
    const bol = { number: raw.bill_of_lading_number, rawData: raw, url: 'https://example.test/bol.pdf', uploadedAt: new Date('2026-09-14') };
    await f.db.outbound.collection.updateMany({}, { $set: { 'loads.0.bol': bol } });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bol-migration-'));
    t.after(() => fs.rmSync(dir, { recursive: true }));
    const inspection = await inspectBolMigration(f.connection.db);
    const result = await migrateBolDocuments({ connection: f.connection, inspection, apply: true, backupPath: path.join(dir, 'backup.jsonl') });
    assert.equal(result.applied, 1);
    assert.equal(await f.db.bolDocument.countDocuments(), 1);
    assert.equal(await f.db.outbound.collection.countDocuments({ 'loads.bol': { $exists: true } }), 0);
    const audit = await f.connection.db.collection('bolMigrationAudit').findOne();
    assert.equal(audit.sourceCount, 19);
    const source = await f.connection.db.collection('bolMigrationSource').findOne({ documentId: audit._id });
    assert.deepEqual(source.bol, bol);
    assert.equal(fs.readFileSync(path.join(dir, 'backup.jsonl'), 'utf8').trim().split('\n').length, 19);
    assert.equal((await inspectBolMigration(f.connection.db)).report.documents, 0);
    const verified = await verifyBolMigration(f.connection.db);
    assert.equal(verified.ok, true, JSON.stringify(verified.errors));
    assert.equal(verified.load77925000.shipments, 19);
    assert.equal(verified.load77925000.documents, 1);
});

test('conservative migration retains the signed variant, newest matching upload and separate unassigned documents', integration, async t => {
    const f = await fixture(t, 6);
    const copies = [
        {number:'A',rawData:{note:'unsigned'}},
        {number:'B',rawData:{note:'signed',driver_signature:'signed-image'}},
        {number:'C',url:'saved.pdf',uploadedAt:new Date('2025-01-01')},
        {number:'C',url:'saved.pdf',uploadedAt:new Date('2025-01-02')},
        {number:'U1'}, {number:'U2'},
    ];
    for (const [index, bol] of copies.entries()) await f.db.outbound.collection.updateOne({poNumber:`PO-${index}`},
        {$set:{'loads.0.bol':bol,'loads.0.loadNumber':index<2?'77925000':index<4?'SECOND':''}});
    const inspection = await inspectBolMigration(f.connection.db);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(),'bol-migration-'));
    t.after(()=>fs.rmSync(dir,{recursive:true}));
    const result=await migrateBolDocuments({connection:f.connection,inspection,apply:true,conservative:true,backupPath:path.join(dir,'backup.jsonl')});
    assert.equal(result.applied,4);
    assert.equal((await f.service.get({loadNumber:'77925000'})).number,'B');
    assert.equal(+(await f.service.get({loadNumber:'SECOND'})).uploadedAt,+copies[3].uploadedAt);
    assert.equal((await f.service.get({shipmentId:'SHIP-4'})).number,'U1');
    assert.equal((await f.service.get({shipmentId:'SHIP-5'})).number,'U2');
    assert.equal((await verifyBolMigration(f.connection.db)).ok,true);
    const archive=await f.connection.db.collection('bolMigrationSource').find().toArray();
    assert.equal(archive.length,6);
    assert.ok(archive.some(source=>source.bol.number==='A'));
    await f.db.outbound.collection.updateOne({poNumber:'PO-4'},{$set:{'loads.0.bolId':new f.connection.base.Types.ObjectId()}});
    assert.equal((await verifyBolMigration(f.connection.db)).ok,false);
});

test('new and reassigned shipments resolve BOL references by load without copying drafts', integration, async t => {
    const f=await fixture(t,1);
    const first=await f.service.save({loadNumber:'77925000',rawData:raw});
    const parent=await f.db.outbound.findOne().lean();
    const invoke=(event,payload)=>new Promise(resolve=>f.handlers[event](payload,resolve));
    assert.equal((await invoke('load:add',{_id:parent._id,load:{shipmentId:'ADDED',loadNumber:'77925000'}})).status,'success');
    assert.equal(String((await f.db.outbound.findOne().lean()).loads[1].bolId),String(first._id));
    assert.equal((await f.sync([{poNumber:'PO-0',load:{shipmentId:'ADDED',loadNumber:'NEW'}}])).status,'success');
    assert.equal((await f.db.outbound.findOne().lean()).loads[1].bolId,null);
    assert.equal((await f.service.get({loadNumber:'77925000'})).rawData.note,'original');
});

test('migration detects a concurrent edit and rolls back document creation and all references', integration, async t => {
    const f = await fixture(t, 2);
    await f.db.outbound.collection.updateMany({}, { $set: { 'loads.0.bol': { number: raw.bill_of_lading_number, rawData: raw } } });
    const inspection = await inspectBolMigration(f.connection.db);
    await f.db.outbound.collection.updateOne({ poNumber: 'PO-1' }, { $set: { 'loads.0.bol.rawData.note': 'concurrent edit' } });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bol-migration-'));
    t.after(() => fs.rmSync(dir, { recursive: true }));
    await assert.rejects(migrateBolDocuments({ connection: f.connection, inspection, apply: true, backupPath: path.join(dir, 'backup.jsonl') }), /changed after inspection/);
    assert.equal(await f.db.bolDocument.countDocuments(), 0);
    assert.equal(await f.db.outbound.collection.countDocuments({ 'loads.bol': { $exists: true } }), 2);
});

 test('missing and empty historical BOLs remain optional and create no placeholder documents', integration, async t=>{
    const f=await fixture(t,3);
    await f.db.outbound.collection.updateOne({poNumber:'PO-0'},{$set:{'loads.0.bol':null}});
    await f.db.outbound.collection.updateOne({poNumber:'PO-1'},{$set:{'loads.0.bol':{number:''}}});
    const inspection=await inspectBolMigration(f.connection.db);assert.equal(inspection.report.documents,0);assert.equal(inspection.report.emptyCopies,2);
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bol-empty-'));t.after(()=>fs.rmSync(dir,{recursive:true}));
    await migrateBolDocuments({connection:f.connection,inspection,apply:true,backupPath:path.join(dir,'backup.jsonl')});
    const rows=await f.db.outbound.collection.find().toArray();assert.ok(rows.every(row=>!row.loads[0].bolId&&!Object.hasOwn(row.loads[0],'bol')));
    assert.equal(await f.db.bolDocument.countDocuments(),0);assert.equal((await verifyBolMigration(f.connection.db)).ok,true);
 });
