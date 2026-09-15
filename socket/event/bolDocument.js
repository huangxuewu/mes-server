const models = require('../../models');
const { getActiveSessionUser } = require('../session');
const { createBolDocumentService } = require('../../utils/bolDocumentService');
const documents = createBolDocumentService(models);

module.exports = socket => {
    for (const [event, action] of [['bol-document:get', documents.get], ['bol-documents:sync', documents.sync], ['bol-document:save', documents.save]]) {
        socket.on(event, async (input, callback) => {
            try {
                await getActiveSessionUser(socket);
                callback?.({ status: 'success', payload: await action(input || {}) });
            } catch (error) { callback?.({ status: 'error', message: error.message }); }
        });
    }
};
