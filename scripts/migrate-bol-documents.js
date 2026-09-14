// Dry-run by default. Conflicting copies require an explicit source selection.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { EJSON } = require('bson');

const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const fingerprint = value => createHash('sha256').update(canonical(value)).digest('hex');
const hasBol = bol => Boolean(bol && (bol.number || bol.rawData || bol.url || bol.link));

const inspectBolMigration = async (database, onProgress = () => {}) => {
    const groups = new Map(), invalid = [], empty = [];
    let orders = 0, loads = 0, migrated = 0;
    for await (const record of database.collection('outbound').find({}, { projection: { loads: 1, poNumber: 1 } }).batchSize(25)) {
        orders++;
        for (const load of record.loads || []) {
            loads++;
            if (load.bolId && !Object.hasOwn(load, 'bol')) { migrated++; continue; }
            if (!Object.hasOwn(load, 'bol')) continue;
            const source = { outboundId: String(record._id), poNumber: record.poNumber, shipmentId: load.shipmentId, loadNumber: load.loadNumber || '', bol: load.bol,
                ...(load.bolId ? { bolId: load.bolId } : {}) };
            if (!load.shipmentId || record.loads.filter(row => row.shipmentId === load.shipmentId).length !== 1) {
                invalid.push({ ...source, bol: undefined, reason: 'Missing or duplicated shipment ID' }); continue;
            }
            if (!hasBol(load.bol)) { empty.push(source); continue; }
            const key = load.loadNumber || `shipment:${load.shipmentId}`;
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(source);
        }
        if (orders % 250 === 0) onProgress({ orders, loads, groups: groups.size });
    }
    const conflicts = [...groups].flatMap(([loadNumber, sources]) => {
        const variants = new Map();
        for (const source of sources) {
            const hash = fingerprint(source.bol);
            if (!variants.has(hash)) variants.set(hash, []);
            variants.get(hash).push(source);
        }
        return variants.size < 2 ? [] : [{ loadNumber, variants: [...variants].map(([hash, copies]) => ({
            fingerprint: hash, number: copies[0].bol.number || '', url: copies[0].bol.url || copies[0].bol.link || '',
            uploadedAt: copies[0].bol.uploadedAt || null, hasDraft: Boolean(copies[0].bol.rawData),
            shipperSigned: Boolean(copies[0].bol.rawData?.shipper_signature), driverSigned: Boolean(copies[0].bol.rawData?.driver_signature),
            sources: copies.map(({ bol, ...source }) => source),
        })) }];
    });
    return { groups, empty, report: { generatedAt: new Date().toISOString(), orders, loads, migrated, documents: groups.size,
        embeddedCopies: [...groups.values()].reduce((sum, rows) => sum + rows.length, 0), emptyCopies: empty.length, invalid, conflicts } };
};

const migrateBolDocuments = async ({ connection, inspection, resolutions = {}, conservative = false, apply = false, backupPath, onProgress = () => {} }) => {
    const { groups, empty, report } = inspection;
    const selections = new Map();
    for (const [loadNumber, sources] of groups) {
        const conflict = report.conflicts.some(row => row.loadNumber === loadNumber);
        const selection = resolutions[loadNumber];
        let selected = conflict ? sources.find(source => source.outboundId === selection?.outboundId && source.shipmentId === selection?.shipmentId) : sources[0];
        if (!selected && conservative) {
            const contentKey = source => { const { uploadedAt, ...content } = source.bol; return fingerprint(content); };
            const counts = new Map();
            for (const source of sources) { const key = contentKey(source); counts.set(key, (counts.get(key) || 0) + 1); }
            const score = source => [Number(Boolean(source.bol.rawData?.driver_signature)) * 2 + Number(Boolean(source.bol.rawData?.shipper_signature)),
                counts.get(contentKey(source)), Number(Boolean(source.bol.url || source.bol.link)), Number(Boolean(source.bol.rawData)),
                Number.isFinite(+new Date(source.bol.uploadedAt)) ? +new Date(source.bol.uploadedAt) : 0];
            selected = [...sources].sort((a, b) => {
                const left = score(a), right = score(b);
                for (let index = 0; index < left.length; index++) if (left[index] !== right[index]) return right[index] - left[index];
                return `${a.outboundId}:${a.shipmentId}`.localeCompare(`${b.outboundId}:${b.shipmentId}`);
            })[0];
        }
        if (selected) selections.set(loadNumber, selected);
    }
    const unresolved = report.conflicts.filter(row => !selections.has(row.loadNumber));
    const result = { ...report, mode: apply ? 'apply' : 'dry-run', unresolved: unresolved.map(row => row.loadNumber), applied: 0,
        selections: [...selections].map(([key, source]) => ({ key, outboundId: source.outboundId, shipmentId: source.shipmentId, number: source.bol.number,
            fingerprint: fingerprint(source.bol), rule: resolutions[key] ? 'user-selected' : conservative ? 'signed-consensus-completeness-latest-upload' : 'identical-copies' })) };
    if (!apply) return result;
    if (report.invalid.length || unresolved.length) throw new Error(`Migration stopped: ${unresolved.length} unresolved loads and ${report.invalid.length} invalid references. No records changed.`);
    if (!backupPath) throw new Error('A backup path is required');
    const backup = fs.openSync(backupPath, 'wx');
    try {
        for (const source of [...groups.values()].flat().concat(empty)) fs.writeSync(backup, EJSON.stringify(source) + '\n');
        fs.fsyncSync(backup);
    } finally { fs.closeSync(backup); }
    const database = connection.db, ObjectId = connection.base.Types.ObjectId;
    await database.collection('bolDocument').createIndex({ loadNumber: 1 }, { unique: true, partialFilterExpression: { loadNumber: { $gt: '' } } });
    await database.collection('bolDocument').createIndex({ shipmentId: 1 }, { unique: true, partialFilterExpression: { loadNumber: '', shipmentId: { $gt: '' } } });
    for (const [loadNumber, sources] of groups) {
        const selected = selections.get(loadNumber);
        const session = await connection.startSession();
        try {
            await session.withTransaction(async () => {
                const identity = selected.loadNumber ? { loadNumber: selected.loadNumber } : { loadNumber: '', shipmentId: selected.shipmentId };
                const existing = await database.collection('bolDocument').findOne(identity, { session });
                if (existing) throw new Error(`Load ${loadNumber} already has a document; rerun inspection before resuming`);
                const id = new ObjectId();
                await database.collection('bolDocument').insertOne({ ...selected.bol, _id: id, ...identity, revision: 1,
                    createdAt: new Date(), updatedAt: new Date(), migrationKey: loadNumber }, { session });
                for (const source of sources) {
                    const changed = await database.collection('outbound').updateOne({ _id: new ObjectId(source.outboundId),
                        loads: { $elemMatch: { shipmentId: source.shipmentId, loadNumber: source.loadNumber || { $in: ['', null] }, bol: source.bol, bolId: { $in: [null] } } } },
                    { $set: { 'loads.$.bolId': id }, $unset: { 'loads.$.bol': '' } }, { session });
                    if (changed.matchedCount !== 1) throw new Error(`Load ${loadNumber} changed after inspection; transaction rolled back`);
                }
                await database.collection('bolMigrationSource').insertMany(sources.map(source => ({ ...source, documentId: id, migratedAt: new Date() })), { session });
                await database.collection('bolMigrationAudit').insertOne({ _id: id, ...identity, sourceCount: sources.length, selected: { outboundId: selected.outboundId,
                    shipmentId: selected.shipmentId }, fingerprint: fingerprint(selected.bol), migratedAt: new Date() }, { session });
            });
            result.applied++;
            if (result.applied % 50 === 0) onProgress({ applied: result.applied, documents: groups.size });
        } finally { await session.endSession(); }
    }
    for (const source of empty) {
        const session = await connection.startSession();
        try {
            await session.withTransaction(async () => {
                const changed = await database.collection('outbound').updateOne({ _id: new ObjectId(source.outboundId),
                    loads: { $elemMatch: { shipmentId: source.shipmentId, loadNumber: source.loadNumber || { $in: ['', null] }, bol: source.bol } } },
                { $set: { 'loads.$.bolId': source.bolId || null }, $unset: { 'loads.$.bol': '' } }, { session });
                if (changed.matchedCount !== 1) throw new Error(`Empty BOL ${source.shipmentId} changed after inspection`);
                await database.collection('bolMigrationSource').insertOne({ ...source, documentId: source.bolId || null, migratedAt: new Date() }, { session });
            });
        } finally { await session.endSession(); }
    }
    return result;
};

const verifyBolMigration = async (database) => {
    const errors = [], documents = new Map(), identities = new Set();
    for await (const doc of database.collection('bolDocument').find({})) {
        const identity = doc.loadNumber ? `load:${doc.loadNumber}` : `shipment:${doc.shipmentId}`;
        if (identities.has(identity) || (!doc.loadNumber && !doc.shipmentId)) errors.push(`Invalid or duplicate identity: ${identity}`);
        identities.add(identity); documents.set(String(doc._id), doc);
    }
    let shipments = 0, references = 0, embedded = 0, archived = 0;
    const targetReferences = [];
    for await (const row of database.collection('outbound').find({}, { projection: { loads: 1 } }).batchSize(100)) {
        for (const load of row.loads || []) {
            shipments++;
            if (Object.hasOwn(load, 'bol')) embedded++;
            if (!load.bolId) continue;
            references++;
            const doc = documents.get(String(load.bolId));
            if (!doc) errors.push(`Dangling reference: ${load.shipmentId}`);
            else if ((load.loadNumber || '') !== doc.loadNumber || (!load.loadNumber && load.shipmentId !== doc.shipmentId)) errors.push(`Wrong document identity: ${load.shipmentId}`);
            if (load.loadNumber === '77925000') targetReferences.push(String(load.bolId));
        }
    }
    if (embedded) errors.push(`${embedded} embedded BOL fields remain`);
    const sourcesByDocument = new Map();
    for await (const source of database.collection('bolMigrationSource').find({})) {
        archived++;
        const id = String(source.documentId);
        if (!sourcesByDocument.has(id)) sourcesByDocument.set(id, []);
        sourcesByDocument.get(id).push(source);
    }
    for await (const audit of database.collection('bolMigrationAudit').find({})) {
        const sources = sourcesByDocument.get(String(audit._id)) || [];
        const selected = sources.find(source => source.outboundId === audit.selected.outboundId && source.shipmentId === audit.selected.shipmentId);
        if (sources.length !== audit.sourceCount || !selected || fingerprint(selected.bol) !== audit.fingerprint) errors.push(`Invalid source archive: ${audit._id}`);
        const document = documents.get(String(audit._id));
        if (!document) errors.push(`Missing migrated document: ${audit._id}`);
        else if (document.revision === 1) {
            const selectedFields = Object.fromEntries(Object.keys(selected?.bol || {}).map(key => [key, document[key]]));
            if (fingerprint(selectedFields) !== audit.fingerprint) errors.push(`Migrated content differs from selection: ${audit._id}`);
        }
    }
    return { verifiedAt: new Date().toISOString(), ok: !errors.length, documents: documents.size, shipments, references, embedded, archived,
        load77925000: { shipments: targetReferences.length, documents: new Set(targetReferences).size }, errors };
};

if (require.main === module) (async () => {
    const apply = process.argv.includes('--apply');
    const value = flag => process.argv[process.argv.indexOf(flag) + 1];
    const reportPath = path.resolve(process.argv.includes('--report') ? value('--report') : 'bol-migration-report.json');
    const resolutions = process.argv.includes('--resolutions') ? JSON.parse(fs.readFileSync(value('--resolutions'), 'utf8')) : {};
    const connection = require('../config/database').connection;
    await connection.asPromise();
    try {
        if (process.argv.includes('--verify')) {
            const verification = await verifyBolMigration(connection.db);
            fs.writeFileSync(reportPath, JSON.stringify(verification, null, 2));
            console.log(JSON.stringify(verification));
            if (!verification.ok) process.exitCode = 1;
            return;
        }
        const inspection = await inspectBolMigration(connection.db, progress => console.log(JSON.stringify(progress)));
        fs.writeFileSync(reportPath, JSON.stringify(inspection.report, null, 2));
        const result = await migrateBolDocuments({ connection, inspection, resolutions, apply, conservative: process.argv.includes('--resolve-conservatively'),
            onProgress: progress => console.log(JSON.stringify(progress)),
            backupPath: apply ? reportPath.replace(/\.json$/, '') + '-backup.jsonl' : null });
        fs.writeFileSync(reportPath, JSON.stringify(result, null, 2));
        console.log(JSON.stringify({ reportPath, documents: result.documents, conflicts: result.conflicts.length, unresolved: result.unresolved, applied: result.applied }));
    } finally { await connection.close(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });

module.exports = { canonical, fingerprint, inspectBolMigration, migrateBolDocuments, verifyBolMigration };
