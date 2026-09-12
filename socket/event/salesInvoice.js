const { getActiveSessionUser, hasPermission } = require('../session');
const flow = require('../../utils/edi/salesInvoices');

module.exports = socket => {
    const actions = { list: ['access', 'financial.page.access'], get: ['access', 'financial.page.access'],
        refresh: ['access', 'financial.page.access'], download: ['access', 'financial.page.access'],
        submit: ['create', 'finance.salesInvoice.submit'], savePdf: ['create', 'finance.salesInvoice.submit'] };
    for (const [action, permission] of Object.entries(actions)) socket.on(`sales-invoice:${action}`, async (input, callback) => {
        try {
            const user = await getActiveSessionUser(socket);
            const generation = socket.data.sessionGeneration;
            const authorize = async () => {
                const current = await getActiveSessionUser(socket);
                if (String(current._id) !== String(user._id) || socket.data.sessionGeneration !== generation) throw new Error('Session changed');
                if (!hasPermission(current, 'access', 'financial.page.access') || !hasPermission(current, ...permission)) throw new Error('Sales invoice permission is required');
            };
            await authorize();
            const result = action === 'submit' ? await flow.submit(input, user._id, authorize)
                : await flow[action](input, authorize);
            await authorize();
            callback?.({ status: 'success', payload: result });
        } catch (error) { callback?.({ status: 'error', message: error.message }); }
    });
};
