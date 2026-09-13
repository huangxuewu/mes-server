const { getActiveSessionUser, hasPermission } = require('../session');
const flow = require('../../utils/edi/salesInvoices');
const { invoiceVisibility } = require('../../utils/edi/invoiceVisibility');

module.exports = socket => {
    const actions = { list: ['access', 'financial.page.access'], get: ['access', 'financial.page.access'],
        refresh: ['access', 'financial.page.access'], download: ['view', 'finance.salesInvoice.amounts'],
        submit: ['create', 'finance.salesInvoice.submit'], savePdf: ['create', 'finance.salesInvoice.submit'] };
    for (const [action, permission] of Object.entries(actions)) socket.on(`sales-invoice:${action}`, async (input, callback) => {
        try {
            const user = await getActiveSessionUser(socket);
            const generation = socket.data.sessionGeneration;
            const authorize = async () => {
                const current = await getActiveSessionUser(socket);
                if (String(current._id) !== String(user._id) || socket.data.sessionGeneration !== generation) throw new Error('Session changed');
                if (!hasPermission(current, 'access', 'financial.page.access') || !hasPermission(current, ...permission)) throw new Error('Sales invoice permission is required');
                return current;
            };
            await authorize();
            const result = action === 'submit' ? await flow.submit(input, user._id, authorize)
                : await flow[action](input, authorize);
            const current = await authorize();
            callback?.({ status: 'success', payload: invoiceVisibility(result, hasPermission(current, 'view', 'finance.salesInvoice.amounts')) });
        } catch (error) {
            let amountsVisible = false;
            try { amountsVisible = hasPermission(await getActiveSessionUser(socket), 'view', 'finance.salesInvoice.amounts'); } catch {}
            const publicErrors = ['Session changed', 'Sales invoice permission is required', 'Sign in to continue', 'Session no longer valid'];
            callback?.({ status: 'error', message: amountsVisible || publicErrors.includes(error.message)
                ? error.message : 'Sales invoice operation failed. Check status and retry.' });
        }
    });
};
