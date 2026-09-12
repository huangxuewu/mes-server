const { createHash } = require('node:crypto');

const createInvoiceMonitor = ({ db, getClient, flow, logger = console, intervalMs = 5 * 60 * 1000 }) => {
    let timer;
    let running;
    let stopped = false;
    const run = () => {
        if (running || stopped) return running;
        running = (async () => {
            const client = await getClient();
            const integrationKey = createHash('sha256').update(`${client.config.baseUrl}:${client.headers['x-tenant-id'] || ''}:OFDHTGTDMS`).digest('hex');
            const cursor = db.salesInvoice.find({ integrationKey, submittedBy: { $exists: true },
                $and: [
                    { $or: [{ submissionStartedAt: { $ne: null } }, { transactionId: { $type: 'string', $ne: '' } }] },
                    { $or: [
                        { statusSource: { $ne: 'orderful' } },
                        { acknowledgmentStatus: { $nin: ['REJECTED', 'ACCEPTEDWITHERRORS'] }, validationStatus: { $ne: 'INVALID' }, deliveryStatus: { $ne: 'FAILED' },
                            $or: [{ acknowledgmentStatus: { $ne: 'ACCEPTED' } }, { pdfPath: null }, { pdfPath: '' }] },
                    ] },
                ],
            }, { poNumber: 1, invoiceDate: 1 }).lean().cursor();
            try {
                for await (const record of cursor) {
                    if (stopped) break;
                    const input = { poNumber: record.poNumber, invoiceDate: record.invoiceDate };
                    try {
                        const detail = await flow.refresh(input);
                        if (!stopped && detail.canSavePdf && !detail.pdfPath) await flow.savePdf(input);
                    } catch (error) { logger.error('Invoice result check failed', { poNumber: record.poNumber, message: error.message }); }
                }
            } finally { await cursor.close(); }
            if (!stopped) {
                try { await flow.syncList(); }
                catch (error) { logger.error('Invoice queue refresh failed', { message: error.message }); }
            }
        })().catch(error => logger.error('Invoice monitor failed', { message: error.message }))
            .finally(() => { running = null; });
        return running;
    };
    const start = () => {
        if (timer) return;
        stopped = false;
        timer = setInterval(run, intervalMs);
        timer.unref?.();
        void run();
    };
    const stop = async () => { stopped = true; clearInterval(timer); timer = null; await running; };
    return { run, start, stop };
};

module.exports = { createInvoiceMonitor };
