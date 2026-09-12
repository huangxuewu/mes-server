const db = require('../../models');
const { getActiveSessionUser, hasPermission } = require('../session');
const { getClient } = require('../../utils/edi/client');
const { getConfiguredDropbox } = require('../../utils/documentStorage');
const { createInvoiceFlow } = require('../../utils/edi/invoiceFlow');

const flow = createInvoiceFlow({ db, getClient, getDropbox: getConfiguredDropbox,
    getOrderfulMessage: async transactionId => {
        const config = await db.config.findOne({ key: 'integration.edi.orderfulApiKey', status: 'Active' }).lean();
        const key = process.env.ORDERFUL_API_KEY || config?.value;
        if (!key) throw new Error('Add the Orderful API key under Integration > EDI to retrieve invoice JSON');
        if (!/^\d+$/.test(String(transactionId))) throw new Error('Invalid Orderful transaction ID');
        const response = await fetch(`https://api.orderful.com/v3/transactions/${transactionId}/message`, {
            headers: { accept: 'application/json', 'orderful-api-key': key }, signal: AbortSignal.timeout(30000), redirect: 'error',
        });
        if (!response.ok) throw new Error(`Orderful invoice JSON fetch failed (${response.status})`);
        return response.json();
    },
});

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
