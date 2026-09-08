// Use the native driver so this audit cannot trigger model initialization or index creation.
const { MongoClient } = require('mongoose').mongo;

const requiredIndexes = [
    { collection: 'productionRun', key: { lineId: 1 }, unique: true, partialFilterExpression: { open: true } },
    { collection: 'productionRun', key: { startRequestId: 1 }, unique: true },
    { collection: 'productionRun', key: { 'lots.number': 1 }, unique: true, partialFilterExpression: { 'lots.number': { $type: 'string' } } },
    { collection: 'pallet', key: { registrationRequestId: 1 }, unique: true, partialFilterExpression: { registrationRequestId: { $type: 'string' } } },
];

const auditProductionReadiness = async database => {
    const hello = await database.admin().command({ hello: 1 });
    const topologySupported = Boolean((hello.setName || hello.msg === 'isdbgrid') && hello.logicalSessionTimeoutMinutes != null && hello.maxWireVersion >= 8);
    const collections = new Set((await database.listCollections({}, { nameOnly: true }).toArray()).map(item => item.name));
    const indexes = [];
    for (const required of requiredIndexes) {
        const actual = collections.has(required.collection) ? await database.collection(required.collection).listIndexes().toArray() : [];
        const match = actual.find(index => JSON.stringify(index.key) === JSON.stringify(required.key)
            && index.unique === true && !index.sparse
            && JSON.stringify(index.partialFilterExpression || null) === JSON.stringify(required.partialFilterExpression || null)
            && (!index.collation || index.collation.locale === 'simple'));
        indexes.push({ collection: required.collection, key: required.key, present: Boolean(match) });
    }
    const duplicateChecks = [
        { name: 'openRunsPerLine', collection: 'productionRun', match: { open: true }, field: 'lineId' },
        { name: 'runStartRequests', collection: 'productionRun', match: {}, field: 'startRequestId' },
        { name: 'palletRegistrationRequests', collection: 'pallet', match: { registrationRequestId: { $type: 'string' } }, field: 'registrationRequestId' },
        { name: 'stockRecordsPerProduct', collection: 'finishedGoods', match: { productId: { $exists: true, $ne: null } }, field: 'productId' },
        { name: 'storageRecordsPerPallet', collection: 'storage', match: { batchNumber: { $type: 'string', $ne: '' } }, field: 'batchNumber' },
    ];
    const duplicates = [];
    for (const check of duplicateChecks) {
        const [result] = collections.has(check.collection) ? await database.collection(check.collection).aggregate([
            { $match: check.match }, { $group: { _id: '$' + check.field, count: { $sum: 1 } } },
            { $match: { count: { $gt: 1 } } }, { $count: 'groups' },
        ], { maxTimeMS: 30000 }).toArray() : [];
        duplicates.push({ check: check.name, groups: result?.groups || 0 });
    }
    const [lotDuplicates] = collections.has('productionRun') ? await database.collection('productionRun').aggregate([
        { $unwind: '$lots' }, { $match: { 'lots.number': { $type: 'string' } } },
        { $group: { _id: '$lots.number', count: { $sum: 1 } } }, { $match: { count: { $gt: 1 } } }, { $count: 'groups' },
    ], { maxTimeMS: 30000 }).toArray() : [];
    duplicates.push({ check: 'lotNumbers', groups: lotDuplicates?.groups || 0 });
    return {
        checkedAt: new Date().toISOString(),
        databaseChecksPassed: topologySupported && indexes.every(index => index.present) && duplicates.every(check => check.groups === 0),
        topologySupported, indexes, duplicates,
        remainingChecks: ['Deploy compatible server and client versions', 'Verify operator permissions', 'Verify physical labels and scans on one line'],
        scope: 'Read-only database checks. Does not prove write permissions, successful transactions, deployed code, or factory pilot completion.',
    };
};

const main = async () => {
    const uri = process.env.PRODUCTION_AUDIT_URI;
    const name = process.env.PRODUCTION_AUDIT_DATABASE;
    if (!uri || !name) throw Error('Set PRODUCTION_AUDIT_URI and PRODUCTION_AUDIT_DATABASE explicitly. No default connection is used.');
    const client = new MongoClient(uri, { serverSelectionTimeoutMS: 10000, readPreference: 'primary', appName: 'MES-read-only-production-audit' });
    try {
        await client.connect();
        const report = await auditProductionReadiness(client.db(name));
        console.log(JSON.stringify(report, null, 2));
        if (!report.databaseChecksPassed) process.exitCode = 2;
    } finally { await client.close(); }
};

if (require.main === module) main().catch(() => {
    // Driver messages may contain connection details; do not print credentials or host names.
    console.error('Production audit failed. Check explicit connection/database settings and read access; no changes were requested.');
    process.exitCode = 1;
});

module.exports = { auditProductionReadiness };
