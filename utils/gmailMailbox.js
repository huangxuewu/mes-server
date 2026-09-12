const migrations = new WeakMap();

// Legacy MES used one mailbox and a globally unique thread ID. Preserve those records on upgrade.
const prepareGmailMailbox = async (connection, mailbox) => {
    let pending = migrations.get(connection);
    if (!pending) { pending = new Map(); migrations.set(connection, pending); }
    if (!pending.has(mailbox)) {
        pending.set(mailbox, (async () => {
            const threads = connection.db.collection('emailThread');
            await threads.createIndex({ mailbox: 1, threadId: 1 }, { unique: true, name: 'mailbox_thread_unique' });
            const session = await connection.startSession();
            try {
                for await (const candidate of threads.find({ mailbox: { $exists: false } }, { projection: { _id: 1 } })) {
                    await session.withTransaction(async () => {
                        const legacy = await threads.findOne({ _id: candidate._id, mailbox: { $exists: false } }, { session });
                        if (!legacy) return;
                        const current = await threads.findOne({ mailbox, threadId: legacy.threadId }, { session });
                        if (!current) {
                            await threads.updateOne({ _id: legacy._id }, { $set: { mailbox } }, { session });
                            return;
                        }
                        // A partially upgraded mailbox can already contain this thread. Keep its ID and
                        // current values, adding legacy messages/associations before removing the old row.
                        const messages = new Map((legacy.messages || []).map(message => [message.messageId, message]));
                        for (const message of current.messages || []) {
                            const previous = messages.get(message.messageId);
                            messages.set(message.messageId, { ...previous, ...message,
                                loadNumbers: [...new Set([...(previous?.loadNumbers || []), ...(message.loadNumbers || [])])] });
                        }
                        const associations = new Map((legacy.loadAssociations || []).map(item => [item.loadNumber, item]));
                        for (const item of current.loadAssociations || []) {
                            associations.set(item.loadNumber, { ...associations.get(item.loadNumber), ...item });
                        }
                        const merged = { ...legacy, ...current, messages: [...messages.values()],
                            loadAssociations: [...associations.values()] };
                        delete merged._id;
                        await threads.updateOne({ _id: current._id }, { $set: merged }, { session });
                        await threads.deleteOne({ _id: legacy._id }, { session });
                    }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
                }
            } finally { await session.endSession(); }
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
