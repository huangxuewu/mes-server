const migrations = new WeakMap();

// Legacy MES used one mailbox and a globally unique thread ID. Preserve those records on upgrade.
const prepareGmailMailbox = async (connection, mailbox) => {
    let pending = migrations.get(connection);
    if (!pending) { pending = new Map(); migrations.set(connection, pending); }
    if (!pending.has(mailbox)) {
        pending.set(mailbox, (async () => {
            const threads = connection.db.collection('emailThread');
            await threads.createIndex({ mailbox: 1, threadId: 1 }, { unique: true, name: 'mailbox_thread_unique' });
            await threads.updateMany({ mailbox: { $exists: false } }, { $set: { mailbox } }, { writeConcern: { w: 'majority' } });
            const indexes = await threads.listIndexes().toArray();
            for (const index of indexes) {
                if (!index.unique || index.key.threadId !== 1 || Object.keys(index.key).length !== 1) continue;
                try { await threads.dropIndex(index.name); }
                catch (error) { if (error.code !== 27) throw error; }
            }
        })().catch(error => { pending.delete(mailbox); throw error; }));
    }
    await pending.get(mailbox);
};

module.exports = { prepareGmailMailbox };
