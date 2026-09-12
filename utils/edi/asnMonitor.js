const { accepted, domestic, readPurchaseOrders } = require('./invoice');
const { createOrderfulClient, readOrderfulPo } = require('./orderful');

const ASN_CHECK_INTERVAL_MS = 5 * 60 * 1000;

const createAsnMonitor = ({ db, getClient, getOrderfulTransaction = createOrderfulClient({ db }), logger = console, intervalMs = ASN_CHECK_INTERVAL_MS }) => {
    let timer;
    let running;
    let stopped = false;
    const run = async () => {
        if (running || stopped) return running;
        running = (async () => {
            const client = await getClient();
            const cursor = db.outbound.find({ client: 'Target', loads: { $elemMatch: {
                status: 'Completed', 'checklist.noticed.status': true,
                $or: [{ 'asn.final': { $ne: true } }, { 'asn.source': { $ne: 'orderful' } }],
            } } }, { poNumber: 1, client: 1, loads: 1 }).lean().cursor();
            try {
                for await (const document of cursor) {
                    if (stopped) break;
                    const loads = document.loads.filter(load => load.status === 'Completed' && load.checklist?.noticed?.status === true
                        && (!load.asn?.final || load.asn?.source !== 'orderful'));
                    let po;
                    let lookupError;
                    try {
                        const orders = await readPurchaseOrders(client, [document.poNumber], false);
                        if (orders.length !== 1 || orders[0].po_number !== document.poNumber) throw new Error('ERP purchase order was not found uniquely');
                        po = await readOrderfulPo({ ...orders[0], edi_transaction: (orders[0].edi_transaction || []).filter(row => row.transaction_type === '856') }, document, {}, getOrderfulTransaction);
                    } catch (error) { lookupError = error; }
                    for (const load of loads) {
                        if (stopped) break;
                        let asn;
                        try {
                            if (lookupError) throw lookupError;
                            const matches = (po.load_shipments || []).filter(shipment =>
                                String(shipment.load_shipment_notice_id) === String(load.shipmentId)
                                && String(shipment.shipment_notice?.shipment_id) === String(load.shipmentId)
                                && String(shipment.load?.load_number) === String(load.loadNumber));
                            if (matches.length !== 1) throw new Error('MES and ERP ASN shipment records do not match');
                            const shipmentId = String(matches[0].id);
                            const transactions = (po.edi_transaction || []).filter(transaction => domestic(transaction)
                                && transaction.transaction_type === '856' && String(transaction.business_number) === shipmentId)
                                .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
                            const updated = transactions[0];
                            if (!updated) throw new Error('Waiting for the submitted ASN transaction ID');
                            const rejected = ['REJECTED', 'ACCEPTEDWITHERRORS'].includes(updated.acknowledgment_status);
                            const success = accepted(updated);
                            const failed = rejected || updated.validation_status === 'INVALID' || updated.delivery_status === 'FAILED';
                            asn = { transactionId: String(updated.id), source: 'orderful', state: success ? 'accepted' : failed ? 'failed' : 'pending',
                                final: success || rejected, validation: updated.validation_status, delivery: updated.delivery_status,
                                acknowledgment: updated.acknowledgment_status, checkedAt: new Date(), error: '' };
                            asn.submittedAt = updated.created_at;
                            asn.acceptedAt = updated.accepted_at;
                        } catch (error) {
                            asn = { ...load.asn, state: 'pending', final: false, checkedAt: new Date(), error: error.message };
                        }
                        // A new submission must not be overwritten by an older check still in flight.
                        try {
                            const { submittedAt, acceptedAt, ...stored } = asn;
                            const update = { 'loads.$[target].asn': stored };
                            if (!asn.error && asn.source === 'orderful') {
                                update['loads.$[target].checklist.noticed.status'] = true;
                                update['loads.$[target].checklist.noticed.timestamp'] = submittedAt;
                                update['loads.$[target].checklist.noticed.acceptedAt'] = acceptedAt || null;
                            }
                            await db.outbound.updateOne({ _id: document._id, client: 'Target' }, {
                                $set: update,
                            }, { arrayFilters: [{ 'target.shipmentId': load.shipmentId, 'target.loadNumber': load.loadNumber,
                                'target.checklist.noticed.status': load.checklist.noticed.status,
                                'target.checklist.noticed.timestamp': load.checklist.noticed.timestamp ?? null,
                                'target.asn.checkedAt': load.asn?.checkedAt ?? null,
                                'target.asn.transactionId': load.asn?.transactionId ?? null }], runValidators: true });
                        } catch (error) { logger.error('ASN status save failed', { poNumber: document.poNumber, message: error.message }); }
                    }
                }
            } finally { await cursor.close(); }
        })().catch(error => logger.error('ASN monitor failed', { message: error.message }))
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
    const stop = async () => {
        stopped = true;
        clearInterval(timer);
        timer = null;
        await running;
    };
    return { run, start, stop };
};

module.exports = { createAsnMonitor, ASN_CHECK_INTERVAL_MS };
