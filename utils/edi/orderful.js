const { domestic } = require('./invoice');
const { readInvoice } = require('../salesInvoicePdf');

// Keep the existing internal transaction shape, but populate it exclusively from Orderful.
const createOrderfulReader = ({ getJson }) => async ({ id, type, businessNumber, poNumber }) => {
    if (!/^\d+$/.test(String(id)) || !['856', '810'].includes(type)) throw new Error('Invalid Orderful transaction identity');
    const [metadata, acknowledgment, message] = await Promise.all([
        getJson(id), getJson(id, '/acknowledgment'), getJson(id, '/message'),
    ]);
    if (String(metadata.id) !== String(id) || metadata.type?.name !== (type === '856' ? '856_SHIP_NOTICE_MANIFEST' : '810_INVOICE')
        || metadata.stream !== 'LIVE' || metadata.sender?.isaId !== 'OFDHTGTDMS' || metadata.receiver?.isaId !== '6111470100'
        || businessNumber && String(metadata.businessNumber) !== String(businessNumber)) throw new Error('Orderful transaction identity does not match the Target PO/shipment');
    const created = new Date(metadata.createdAt);
    if (!metadata.createdAt || !Number.isFinite(+created) || created > new Date()) throw new Error('Orderful submission timestamp is missing or invalid');
    if (acknowledgment && (String(acknowledgment.transactionId) !== String(id) || acknowledgment.status !== metadata.acknowledgmentStatus))
        throw new Error('Orderful acknowledgment changed or does not match the transaction; retry');
    const terminal = ['ACCEPTED', 'REJECTED', 'ACCEPTEDWITHERRORS'].includes(metadata.acknowledgmentStatus);
    if (terminal && !acknowledgment) throw new Error('Orderful acknowledgment is not available yet');
    let acceptedAt = null;
    if (metadata.acknowledgmentStatus === 'ACCEPTED') {
        const date = new Date(acknowledgment.createdAt);
        if (!acknowledgment.createdAt || !Number.isFinite(+date) || date < created || date > new Date())
            throw new Error('Orderful acceptance timestamp is missing or invalid');
        acceptedAt = date.toISOString();
    }
    const transaction = { id: String(id), transaction_type: type, business_number: String(metadata.businessNumber),
        stream: metadata.stream, sender_isa_id: metadata.sender.isaId, receiver_isa_id: metadata.receiver.isaId,
        validation_status: metadata.validationStatus, delivery_status: metadata.deliveryStatus, acknowledgment_status: metadata.acknowledgmentStatus,
        created_at: created.toISOString(), accepted_at: acceptedAt, status_source: 'orderful', document: { json_data: message } };
    if (type === '810') readInvoice(transaction, poNumber);
    else {
        const set = message?.transactionSets?.[0];
        const references = (set?.HL_loop || []).flatMap(level => level.purchaseOrderReference || []);
        if (message?.transactionSets?.length !== 1 || set?.transactionSetHeader?.[0]?.transactionSetIdentifierCode !== '856'
            || String(set.beginningSegmentForShipNotice?.[0]?.shipmentIdentification) !== transaction.business_number
            || !references.length || references.some(reference => reference.purchaseOrderNumber !== poNumber))
            throw new Error('Orderful ASN document does not match the shipment PO');
    }
    return transaction;
};

const createOrderfulClient = ({ db, fetchImpl = fetch }) => createOrderfulReader({ getJson: async (id, suffix = '') => {
    const config = await db.config.findOne({ key: 'integration.edi.orderfulApiKey', status: 'Active' }).lean();
    const key = process.env.ORDERFUL_API_KEY || config?.value;
    if (!key) throw new Error('Configure the MES Orderful API key to verify EDI status');
    const response = await fetchImpl(`https://api.orderful.com/v3/transactions/${id}${suffix}`, {
        headers: { accept: 'application/json', 'orderful-api-key': key }, signal: AbortSignal.timeout(30000), redirect: 'error',
    });
    if (response.status === 404 && suffix === '/acknowledgment') return null;
    if (!response.ok) throw new Error(`Orderful transaction read failed (${response.status})`);
    return response.json();
} });

// ERP is used only to discover IDs and associate its shipment identifiers with MES loads.
// Saved IDs also work before ERP's transaction list catches up after submission.
const readOrderfulPo = async (po, mes, record, getTransaction) => {
    const candidates = new Map((po.edi_transaction || []).filter(transaction => domestic(transaction)
        && ['856', '810'].includes(transaction.transaction_type)).map(transaction => [String(transaction.id), {
        id: String(transaction.id), type: transaction.transaction_type, businessNumber: transaction.business_number, poNumber: po.po_number,
    }]));
    for (const load of mes.loads || []) if (load.asn?.transactionId && !candidates.has(String(load.asn.transactionId))) {
        const matches = (po.load_shipments || []).filter(shipment => String(shipment.load_shipment_notice_id) === String(load.shipmentId)
            && String(shipment.shipment_notice?.shipment_id) === String(load.shipmentId) && shipment.load?.load_number === load.loadNumber);
        if (matches.length !== 1) throw new Error('MES and ERP ASN shipment records do not match');
        candidates.set(String(load.asn.transactionId), { id: String(load.asn.transactionId), type: '856', businessNumber: String(matches[0].id), poNumber: po.po_number });
    }
    if (record?.transactionId && !candidates.has(String(record.transactionId))) candidates.set(String(record.transactionId), {
        id: String(record.transactionId), type: '810', businessNumber: record.invoiceNumber, poNumber: po.po_number,
    });
    const transactions = [];
    for (const candidate of candidates.values()) transactions.push(await getTransaction(candidate));
    return { ...po, edi_transaction: transactions };
};

module.exports = { createOrderfulReader, createOrderfulClient, readOrderfulPo };
