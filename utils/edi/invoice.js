const { createHash } = require('node:crypto');

// Verified against the deployed DMS invoice screen and ERP GraphQL schema, 2026-09-12.
const TRANSACTION_FIELDS = `id transaction_type business_number created_at stream sender_isa_id receiver_isa_id
    validation_status delivery_status acknowledgment_status document { json_data }`;
const INVOICE_QUERY = `query MesInvoice($filter: PurchaseOrderFilter, $first: Int, $after: String) {
    po(filter: $filter, first: $first, after: $after) {
        edges { node {
            po_number vendor_id vendor_name department po_status po_created_at
            payment_type_code payment_basis_date_code payment_terms_discount payment_discount_days_due payment_terms_net_days
            destinationCenter { dc_code dc_name address_line city state zip_code port_code }
            items { id external_id item_bar_code tcin item_description item_unit_cost total_item_qty }
            load_shipments { id load_shipment_notice_id created_at load { load_number bol_number }
                shipment_notice { shipment_id status assigned_scac executing_scac pro bol }
                shipment_tracking { asn_sent_at } }
            edi_transaction { ${TRANSACTION_FIELDS} }
        } }
        pageInfo { hasNextPage endCursor }
    }
}`;
const REFRESH_INVOICE = `mutation MesRefreshInvoice($id: Int!) {
    refreshTransaction(account_code: Domestic, transaction_id: $id) { ${TRANSACTION_FIELDS} }
}`;
const CREATE_INVOICE = `mutation MesCreateInvoice($input: CreateTransactionInput!) {
    createTransaction(input: $input) { id }
}`;
const text = value => String(value ?? '').trim();
const code = value => text(value).replace(/[^0-9A-Za-z]/g, '');
const accepted = transaction => transaction?.validation_status === 'VALID'
    && transaction.delivery_status === 'DELIVERED' && transaction.acknowledgment_status === 'ACCEPTED';
const domestic = transaction => transaction.stream === 'LIVE' && transaction.sender_isa_id === 'OFDHTGTDMS'
    && transaction.receiver_isa_id === '6111470100';
const documentJson = transaction => {
    const value = transaction?.document?.json_data;
    const json = typeof value === 'string' ? JSON.parse(value) : value;
    return Array.isArray(json) && json.length === 1 ? json[0] : json;
};
const transactionSet = transaction => {
    const json = documentJson(transaction);
    if (!json) return null;
    if (json.transactionSets?.length !== 1) throw new Error('Expected exactly one EDI transaction set');
    return json.transactionSets[0];
};

// Decimal prices are multiplied before rounding, matching the ERP's decimal total.
const amountCents = items => {
    let millionths = 0n;
    for (const item of items) {
        const price = text(item.unitPrice);
        if (!/^\d+(\.\d{1,6})?$/.test(price) || !Number.isSafeInteger(item.quantity) || item.quantity < 0)
            throw new Error('Invoice contains an invalid quantity or unit price');
        const [whole, fraction = ''] = price.split('.');
        millionths += (BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, '0'))) * BigInt(item.quantity);
    }
    const cents = (millionths + 5000n) / 10000n;
    if (cents > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Invoice amount is too large');
    return Number(cents);
};

const isPoLoaded = mes => {
    if (!mes.items?.length) return false;
    const required = new Map();
    for (const item of mes.items) {
        if (!item.styleCode || !Number.isSafeInteger(item.quantity) || item.quantity < 0) return false;
        required.set(item.styleCode, (required.get(item.styleCode) || 0) + item.quantity);
    }
    const loaded = new Map();
    for (const load of mes.loads || []) {
        if (['Cancelled', 'Canceled'].includes(load.status) || load.checklist?.loaded?.status !== true) continue;
        // MES loads inherit the PO items unless they have their own allocation.
        const items = load.items ?? mes.items;
        if (!Array.isArray(items)) return false;
        for (const item of items) {
            if (!required.has(item.styleCode) || !Number.isSafeInteger(item.quantity) || item.quantity < 0) return false;
            loaded.set(item.styleCode, (loaded.get(item.styleCode) || 0) + item.quantity);
        }
    }
    return [...required.values()].some(quantity => quantity > 0)
        && [...required].every(([styleCode, quantity]) => (loaded.get(styleCode) || 0) === quantity);
};

const inspectInvoice = (po, mes, record = {}) => {
    if (mes?.client !== 'Target') throw new Error('Sales invoices currently support Target orders only');
    if (!po || po.po_number !== mes.poNumber) throw new Error('ERP purchase order was not found uniquely');
    const transactions = (po.edi_transaction || []).filter(domestic);
    const invoices = transactions.filter(transaction => transaction.transaction_type === '810')
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    if (invoices.length > 1) throw new Error('Multiple live invoices exist for this PO. Review them in ERP.');
    const invoice = invoices[0];
    if (record.transactionId && invoice && record.transactionId !== invoice.id)
        throw new Error('ERP invoice differs from the recorded invoice. Review in ERP.');
    if (invoice) return { poNumber: po.po_number, invoiceNumber: invoice.business_number, invoice,
        transactionId: invoice.id, ready: false, reasons: [], asns: [],
        asnAccepted: transactions.some(transaction => transaction.transaction_type === '856')
            && transactions.filter(transaction => transaction.transaction_type === '856').every(accepted),
        loadNumbers: [...new Set((mes.loads || []).map(load => load.loadNumber))],
        pdfPath: record.pdfPath || '', pdfSavedAt: record.pdfSavedAt || null };
    const asns = new Map();
    for (const transaction of transactions.filter(transaction => transaction.transaction_type === '856')) {
        const set = transactionSet(transaction);
        const id = text(set?.beginningSegmentForShipNotice?.[0]?.shipmentIdentification || transaction.business_number);
        if (!id) throw new Error('ASN shipment identification is missing');
        if (!asns.has(id) || new Date(transaction.created_at) > new Date(asns.get(id).created_at)) asns.set(id, transaction);
    }
    const required = new Map();
    const items = [...(po.items || [])].sort((a, b) => Number(a.id) - Number(b.id)).map((item, index) => {
        const quantity = Number(item.total_item_qty);
        const key = code(item.external_id);
        if (!key || !Number.isSafeInteger(quantity) || quantity < 0) throw new Error('ERP PO item identifiers or quantities are invalid');
        required.set(key, (required.get(key) || 0) + quantity);
        return { line: index + 1, externalId: key, productCode: item.item_bar_code || item.tcin,
            qualifier: item.item_bar_code ? 'UP' : 'VN', description: item.item_description || key,
            quantity, unitPrice: text(item.item_unit_cost), unit: 'EA' };
    }).filter(item => item.quantity > 0);
    const totalCents = amountCents(items);
    const sent = new Map();
    const reasons = [];
    const mesLoads = (mes.loads || []).filter(load => load.status !== 'Cancelled' && load.status !== 'Canceled');
    if (!isPoLoaded(mes) || mesLoads.some(load => load.status !== 'Completed')) reasons.push('shipmentIncomplete');
    if (['CANCELLED', 'CANCELED'].includes(text(po.po_status).toUpperCase())) reasons.push('poCancelled');
    if (!items.length) reasons.push('noItems');
    const relevant = [];
    for (const load of mesLoads) {
        const matches = (po.load_shipments || []).filter(shipment => text(shipment.load_shipment_notice_id) === text(load.shipmentId)
            && text(shipment.shipment_notice?.shipment_id) === text(load.shipmentId)
            && text(shipment.load?.load_number) === text(load.loadNumber));
        if (matches.length !== 1 || /cancel/i.test(matches[0]?.shipment_notice?.status || '')) { reasons.push('shipmentMismatch'); continue; }
        const shipment = matches[0];
        const asn = asns.get(text(shipment.id));
        relevant.push({ shipment, asn });
        if (!accepted(asn) || (load.asn?.transactionId && String(asn?.id) !== load.asn.transactionId)) reasons.push('asnNotAccepted');
    }
    for (const [shipmentId, asn] of asns) {
        if (!accepted(asn)) { reasons.push('asnNotAccepted'); continue; }
        const set = transactionSet(asn);
        const levels = set?.HL_loop || [];
        const orderNumbers = levels.flatMap(level => level.purchaseOrderReference || []).map(reference => reference.purchaseOrderNumber);
        if (!orderNumbers.length || orderNumbers.some(number => number !== po.po_number)) { reasons.push('shipmentMismatch'); continue; }
        if (!relevant.some(row => text(row.shipment.id) === shipmentId)) { reasons.push('shipmentMismatch'); continue; }
        for (const level of levels.filter(level => level.hierarchicalLevel?.[0]?.hierarchicalLevelCode === 'I')) {
            const item = level.itemIdentification?.[0] || {};
            const identifiers = ['', '1', '2', '3'].map(suffix => ({ qualifier: item[`productServiceIDQualifier${suffix}`], value: item[`productServiceID${suffix}`] }));
            const id = code((identifiers.find(value => value.qualifier === 'CB') || identifiers.find(value => value.qualifier === 'IN'))?.value);
            const quantity = Number(level.itemDetailShipment?.[0]?.numberOfUnitsShipped);
            if (!required.has(id) || !Number.isSafeInteger(quantity) || quantity < 0 || level.itemDetailShipment?.[0]?.unitOrBasisForMeasurementCode !== 'EA') {
                reasons.push('quantityMismatch'); continue;
            }
            sent.set(id, (sent.get(id) || 0) + quantity);
        }
    }
    if ([...required].some(([id, quantity]) => (sent.get(id) || 0) !== quantity)) reasons.push('quantityMismatch');
    if (!po.vendor_id || !po.department || !po.destinationCenter?.dc_name || !/^\d{4}$/.test(text(po.destinationCenter?.dc_code))) reasons.push('missingDetails');
    const first = relevant.sort((a, b) => new Date(a.shipment.created_at) - new Date(b.shipment.created_at))[0];
    const asnSet = first?.asn && transactionSet(first.asn);
    const shipping = asnSet?.HL_loop?.find(level => level.hierarchicalLevel?.[0]?.hierarchicalLevelCode === 'S');
    const carrier = shipping?.carrierDetailsRoutingSequenceTransitTime?.[0];
    const bol = shipping?.referenceInformation?.find(reference => ['BM', 'MB'].includes(reference.referenceIdentificationQualifier))?.referenceIdentification;
    const shipDate = asnSet?.beginningSegmentForShipNotice?.[0]?.date;
    if (!carrier?.identificationCode || !carrier?.transportationMethodTypeCode || !bol || !/^\d{8}$/.test(shipDate || '')) reasons.push('missingDetails');
    if (record.submissionStartedAt && !invoice) reasons.push('submissionUnknown');
    const invoiceNumber = invoice?.business_number || record.invoiceNumber || `VS${po.po_number.replace(/-/g, '')}`;
    return { poNumber: po.po_number, invoiceNumber, totalCents, items,
        reasons: [...new Set(reasons)], ready: !reasons.length && !invoice,
        asnAccepted: relevant.length > 0 && relevant.every(row => accepted(row.asn)) && !reasons.includes('asnNotAccepted'),
        invoice, carrier, bol, shipDate, buyer: po.destinationCenter,
        loadNumbers: [...new Set(mesLoads.map(load => load.loadNumber))],
        pdfPath: record.pdfPath || '', pdfSavedAt: record.pdfSavedAt || null,
        transactionId: invoice?.id || record.transactionId || '',
        asns: relevant.map(({ shipment, asn }) => ({ shipmentId: shipment.id, transactionId: asn?.id, acknowledgment: asn?.acknowledgment_status || 'MISSING' })) };
};

const buildInvoice = (po, state, invoiceDate) => {
    if (!state.ready) throw new Error('Invoice is not ready for submission');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(invoiceDate || '') || new Date(`${invoiceDate}T00:00:00Z`).toISOString().slice(0, 10) !== invoiceDate)
        throw new Error('A valid invoice date is required');
    const terms = Object.fromEntries(Object.entries({ termsTypeCode: po.payment_type_code, termsBasisDateCode: po.payment_basis_date_code,
        termsNetDays: po.payment_terms_net_days, termsDiscountPercent: po.payment_terms_discount,
        termsDiscountDaysDue: po.payment_discount_days_due }).filter(([, value]) => value != null && value !== '').map(([key, value]) => [key, text(value)]));
    const set = {
        transactionSetHeader: [{ transactionSetIdentifierCode: '810', transactionSetControlNumber: '0001' }],
        beginningSegmentForInvoice: [{ date: invoiceDate.replace(/-/g, ''), invoiceNumber: state.invoiceNumber, purchaseOrderNumber: po.po_number }],
        referenceInformation: [{ referenceIdentificationQualifier: 'IA', referenceIdentification: po.vendor_id }, { referenceIdentificationQualifier: 'DP', referenceIdentification: po.department }],
        carrierDetails: [{ transportationMethodTypeCode: state.carrier.transportationMethodTypeCode, standardCarrierAlphaCode: state.carrier.identificationCode,
            referenceIdentificationQualifier: 'BM', referenceIdentification: state.bol }],
        N1_loop: [{ partyIdentification: [{ entityIdentifierCode: 'BY', name: po.destinationCenter.dc_name, identificationCodeQualifier: '92', identificationCode: po.destinationCenter.dc_code }] }],
        ...(Object.keys(terms).length ? { termsOfSaleDeferredTermsOfSale: [terms] } : {}),
        dateTimeReference: [{ dateTimeQualifier: '011', date: state.shipDate }],
        IT1_loop: state.items.map(item => ({ baselineItemDataInvoice: [{ assignedIdentification: String(item.line), quantityInvoiced: String(item.quantity),
            unitOrBasisForMeasurementCode: item.unit, unitPrice: item.unitPrice, productServiceIDQualifier: item.qualifier, productServiceID: item.productCode || '',
            productServiceIDQualifier1: 'CB', productServiceID1: item.externalId }] })),
        ISS_loop: [{ invoiceShipmentSummary: [{ numberOfUnitsShipped: String(state.items.reduce((sum, item) => sum + item.quantity, 0)), unitOrBasisForMeasurementCode: 'EA' }] }],
        totalMonetaryValueSummary: [{ amount: String(state.totalCents) }],
        transactionTotals: [{ numberOfLineItems: String(state.items.length) }],
    };
    const countSegments = node => Object.entries(node).reduce((sum, [key, values]) => sum +
        (key.endsWith('_loop') ? values.reduce((total, value) => total + countSegments(value), 0) : values.length), 0);
    set.transactionSetTrailer = [{ numberOfIncludedSegments: String(countSegments(set) + 1), transactionSetControlNumber: '0001' }];
    return { transactionSets: [set] };
};
const invoiceFingerprint = message => createHash('sha256').update(JSON.stringify(message)).digest('hex');

const readPurchaseOrders = async (client, numbers) => {
    const rows = [];
    let after;
    do {
        const data = await client.graphql(INVOICE_QUERY, { filter: { po_number: { in: numbers } }, first: 100, after });
        if (!data?.po?.edges) throw new Error('ERP did not return purchase orders');
        rows.push(...data.po.edges.map(edge => edge.node));
        const page = data.po.pageInfo;
        if (!page?.hasNextPage) break;
        if (!page.endCursor || after === page.endCursor) throw new Error('ERP pagination did not advance');
        after = page.endCursor;
    } while (true);
    return rows;
};

module.exports = { INVOICE_QUERY, REFRESH_INVOICE, CREATE_INVOICE, accepted, domestic, documentJson, transactionSet,
    amountCents, isPoLoaded, inspectInvoice, buildInvoice, invoiceFingerprint, readPurchaseOrders };
