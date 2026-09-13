// Backfill only the current sales-invoice queue by default. No writes without --apply.
const { accepted, domestic, readPurchaseOrders } = require('../utils/edi/invoice');
const { createOrderfulReader, readOrderfulPo } = require('../utils/edi/orderful');

const findShipmentAsn = (po, load) => {
    const shipments = (po.load_shipments || []).filter(shipment => String(shipment.load_shipment_notice_id) === String(load.shipmentId)
        && String(shipment.shipment_notice?.shipment_id) === String(load.shipmentId) && shipment.load?.load_number === load.loadNumber);
    if (shipments.length !== 1) throw new Error('MES and ERP shipment/load do not match uniquely');
    const transactions = (po.edi_transaction || []).filter(transaction => domestic(transaction)
        && transaction.transaction_type === '856' && String(transaction.business_number) === String(shipments[0].id))
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    const transaction = transactions[0];
    if (!transaction || !accepted(transaction)) throw new Error('Latest Orderful ASN is not accepted');
    if (transactions.length > 1 && (transactions.some(value => !value.created_at || !Number.isFinite(new Date(value.created_at).getTime()))
        || +new Date(transaction.created_at) === +new Date(transactions[1].created_at))) throw new Error('Latest ASN is ambiguous');
    return transaction;
};

const migrateAsnTimestamps = async ({ db, client, getOrderful, poNumbers, apply = false, onReport = async () => {} }) => {
    const readTransaction = createOrderfulReader({ getJson: getOrderful });
    const report = { mode: apply ? 'apply' : 'dry-run', startedAt: new Date().toISOString(), rows: [] };
    const documents = await db.outbound.find({ client: 'Target', poNumber: { $in: poNumbers } }).lean();
    const orders = documents.length ? await readPurchaseOrders(client, documents.map(document => document.poNumber), false) : [];
    for (const document of documents) {
        const loads = (document.loads || []).filter(load => load.status === 'Completed' && Object.hasOwn(load.checklist || {}, 'noticed'));
        for (const load of loads) {
            const row = { poNumber: document.poNumber, loadNumber: load.loadNumber, shipmentId: load.shipmentId, outcome: 'skipped' };
            report.rows.push(row);
            try {
                if (!load.shipmentId || !load.loadNumber || loads.filter(value => value.shipmentId === load.shipmentId && value.loadNumber === load.loadNumber).length !== 1)
                    throw new Error('MES shipment/load is missing or duplicated');
                const matches = orders.filter(po => po.po_number === document.poNumber);
                if (matches.length !== 1) throw new Error('ERP PO does not match uniquely');
                const verified = await readOrderfulPo({ ...matches[0], edi_transaction: (matches[0].edi_transaction || []).filter(row => row.transaction_type === '856') }, { ...document, loads: [load] }, {}, readTransaction);
                const transaction = findShipmentAsn(verified, load);
                row.transactionId = String(transaction.id);
                const noticed = load.checklist.noticed;
                if (!noticed || typeof noticed !== 'object') throw new Error('MES noticed checklist is malformed');
                const submittedAt = new Date(transaction.created_at);
                const acceptedAt = new Date(transaction.accepted_at);
                const changes = {};
                if (noticed.status !== true) changes['checklist.noticed.status'] = true;
                if (+new Date(noticed.timestamp) !== +submittedAt) changes['checklist.noticed.timestamp'] = submittedAt;
                if (+new Date(noticed.acceptedAt) !== +acceptedAt) changes['checklist.noticed.acceptedAt'] = acceptedAt;
                if (String(load.asn?.transactionId) !== String(transaction.id) || load.asn?.source !== 'orderful' || load.asn.state !== 'accepted' || !load.asn.final)
                    changes.asn = { ...load.asn, transactionId: String(transaction.id), source: 'orderful', state: 'accepted', final: true,
                        validation: 'VALID', delivery: 'DELIVERED', acknowledgment: 'ACCEPTED', checkedAt: new Date(), error: '' };
                row.before = { noticed, ...(load.asn ? { asn: load.asn } : {}) };
                row.changes = changes;
                row.sources = { submittedAt: 'Orderful transaction.createdAt', acceptedAt: 'Orderful acknowledgment.createdAt',
                    transactionCreatedAt: submittedAt.toISOString(), acknowledgmentCreatedAt: acceptedAt.toISOString() };
                row.outcome = Object.keys(changes).length ? 'would-update' : 'unchanged';
                await onReport(report); // Persist the original values before any database write.
                if (!apply || row.outcome === 'unchanged') continue;
                const fresh = await readPurchaseOrders(client, [document.poNumber], false);
                if (fresh.length !== 1 || String(findShipmentAsn(await readOrderfulPo({ ...fresh[0], edi_transaction: (fresh[0].edi_transaction || []).filter(row => row.transaction_type === '856') }, { ...document, loads: [load] }, {}, readTransaction), load).id) !== String(transaction.id))
                    throw new Error('ASN changed during migration; no update applied');
                const match = { shipmentId: load.shipmentId, loadNumber: load.loadNumber, status: 'Completed' };
                // Mongoose array filters require schema leaf paths, not the nested object names.
                for (const [prefix, value, fields] of [
                    ['checklist.noticed', noticed, ['status', 'timestamp', 'acceptedAt']],
                    ['asn', load.asn || {}, ['transactionId', 'source', 'state', 'final', 'validation', 'delivery', 'acknowledgment', 'checkedAt', 'error']],
                ]) for (const field of fields) match[`${prefix}.${field}`] = Object.hasOwn(value, field) ? value[field] : { $exists: false };
                const result = await db.outbound.updateOne({ _id: document._id, client: 'Target', loads: { $elemMatch: match } }, {
                    $set: Object.fromEntries(Object.entries(changes).map(([key, value]) => [`loads.$[target].${key}`, value])),
                }, { arrayFilters: [Object.fromEntries(Object.entries(match).map(([key, value]) => [`target.${key}`, value]))], runValidators: true });
                row.outcome = result.modifiedCount ? 'updated' : 'stale';
                if (!result.modifiedCount) row.reason = 'MES load changed during migration; no update applied';
            } catch (error) { row.outcome = 'skipped'; row.reason = error.message; }
            await onReport(report);
        }
    }
    report.finishedAt = new Date().toISOString();
    report.counts = report.rows.reduce((counts, row) => ({ ...counts, [row.outcome]: (counts[row.outcome] || 0) + 1 }), {});
    await onReport(report);
    return report;
};

if (require.main === module) {
    const fs = require('node:fs');
    const path = require('node:path');
    const args = process.argv.slice(2);
    const invalid = args.find(arg => !['--apply', '--dry-run'].includes(arg) && !arg.startsWith('--po=') && !arg.startsWith('--report='));
    if (invalid || args.includes('--apply') && args.includes('--dry-run')) {
        console.error('Usage: node scripts/migrate-asn-timestamps.js [--dry-run | --apply] [--po=FULL-PO] [--report=FILE.json]');
        process.exit(1);
    }
    const mongoose = require('../config/database');
    const db = require('../models');
    const { getClient } = require('../utils/edi/client');
    const { createInvoiceFlow } = require('../utils/edi/invoiceFlow');
    (async () => {
        await mongoose.connection.asPromise();
        const client = await getClient();
        const config = await db.config.findOne({ key: 'integration.edi.orderfulApiKey', status: 'Active' }).lean();
        const key = config?.value;
        if (!key) throw new Error('Configure the MES Orderful API token first');
        const selected = args.filter(arg => arg.startsWith('--po=')).map(arg => arg.slice(5));
        if (selected.some(po => !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(po))) throw new Error('Invalid full PO number');
        const poNumbers = selected.length ? [...new Set(selected)] : (await createInvoiceFlow({ db, getClient }).verifyQueue()).rows.map(row => row.poNumber);
        const reportPath = path.resolve(args.find(arg => arg.startsWith('--report='))?.slice(9)
            || `tmp/asn-timestamps-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
        if (fs.existsSync(reportPath)) throw new Error('Report already exists; use a new filename to preserve the previous backup');
        fs.mkdirSync(path.dirname(reportPath), { recursive: true });
        console.log(`Checking ${poNumbers.length} POs; ${args.includes('--apply') ? 'APPLY' : 'DRY RUN'}; report: ${reportPath}`);
        const report = await migrateAsnTimestamps({ db, client, poNumbers, apply: args.includes('--apply'),
            getOrderful: async (id, suffix = '') => {
                if (!/^\d+$/.test(String(id))) throw new Error('Invalid ASN transaction ID');
                const response = await fetch(`https://api.orderful.com/v3/transactions/${id}${suffix}`, {
                    headers: { accept: 'application/json', 'orderful-api-key': key }, signal: AbortSignal.timeout(30000), redirect: 'error',
                });
                if (response.status === 404 && suffix === '/acknowledgment') return null;
                if (!response.ok) throw new Error(`Orderful read failed (${response.status})`);
                return response.json();
            }, onReport: async value => fs.writeFileSync(reportPath, JSON.stringify(value, null, 2) + '\n') });
        console.log(JSON.stringify(report.counts));
        process.exit(report.counts.skipped || report.counts.stale ? 2 : 0);
    })().catch(error => { console.error(error.message); process.exit(1); });
}

module.exports = { migrateAsnTimestamps };
