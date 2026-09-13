const mongoose = require('mongoose');
const { createDataSync } = require('../../utils/dataSync');
const [uri, database, mode] = process.argv.slice(2);
if (!/^mongodb:\/\/(127\.0\.0\.1|localhost):\d+\/data_sync_test_[a-z\d_]+(?:\?|$)/i.test(uri)
    || !/^data_sync_test_[a-f\d]+$/.test(database)) throw new Error('Isolated sync test database required');
(async () => {
    const connection = await mongoose.createConnection(uri, { dbName: database }).asPromise();
    if (mode === 'hold-batch') {
        const collection = connection.db.collection.bind(connection.db);
        connection.db.collection = name => {
            const target = collection(name);
            if (name === 'syncJournalV2') {
                const insert = target.insertMany.bind(target);
                target.insertMany = async (...args) => {
                    const result = await insert(...args);
                    if (args[0].length < 2) return result;
                    process.send?.({ batchStaged: args[0].length });
                    await new Promise(() => {}); // Parent deliberately kills this uncommitted transaction.
                    return result;
                };
            }
            return target;
        };
    }
    const service = createDataSync({ connection, leaseMs: 1500,
        getBusinessContext: async () => ({ businessDate: '2026-09-07', timeZone: 'America/New_York' }),
        logger: { info() {}, warn() {}, error() {} },
    });
    service.start();
    for (let i = 0; i < 200; i++) {
        if ((await service.status()).capture.available) { process.send?.('ready'); return; }
        await new Promise(resolve => setTimeout(resolve, 30));
    }
    throw new Error('Child consumer did not become ready');
})().catch(error => { process.send?.({ error: error.message }); process.exit(1); });
