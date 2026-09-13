// Only explicitly supported nonfinancial fields may cross the restricted response boundary.
const pick = (value, keys) => Object.fromEntries(keys.filter(key => value?.[key] !== undefined).map(key => [key, value[key]]));
const itemFields = ['line', 'externalId', 'description', 'productCode', 'qualifier', 'quantity', 'unit'];
const addressFields = ['dc_name', 'dc_code', 'address_line', 'city', 'state', 'zip_code', 'port_code'];

const invoiceVisibility = (result, amountsVisible) => {
    if (!result) return result;
    if (result.rows) return { amountsVisible, rows: result.rows.map(row => invoiceVisibility(row, amountsVisible)) };
    const availability = { amountsVisible, hasJson: !!result.json, hasPdf: !!result.pdfPath };
    if (amountsVisible) return { ...result, ...availability };
    const safe = { ...pick(result, ['poNumber', 'invoiceNumber', 'invoiceDate', 'ready', 'asnAccepted', 'reasons',
        'loadNumbers', 'bolUrls', 'transactionId', 'acknowledgment', 'checkedAt', 'pdfSavedAt', 'inQueue',
        'canSavePdf', 'fingerprint', 'reviewFingerprint', 'existing']), ...availability };
    if (result.error) safe.error = 'Sales invoice status could not be verified.';
    if (result.timeline) safe.timeline = pick(result.timeline, ['shipped', 'shippedAt', 'shippedLoadNumber', 'asnSubmitted',
        'asnSubmittedAt', 'asnSubmittedLoadNumber', 'asnAt', 'asnAcceptedLoadNumber', 'invoicedAt', 'invoiceAcceptedAt']);
    if (result.invoice) safe.invoice = pick(result.invoice, ['id', 'validation', 'delivery', 'acknowledgment']);
    if (result.items) safe.items = result.items.map(item => pick(item, itemFields));
    if (result.preview) {
        safe.preview = pick(result.preview, ['poNumber', 'invoiceNumber', 'invoiceDate']);
        safe.preview.items = (result.preview.items || []).map(item => pick(item, itemFields));
        if (result.preview.buyer) safe.preview.buyer = pick(result.preview.buyer, addressFields);
        if (result.preview.parties) safe.preview.parties = result.preview.parties.map(party => pick(party, ['entityIdentifierCode', 'name']));
    }
    if (result.review) {
        safe.review = pick(result.review, ['invoiceNumber', 'invoiceDate', 'shipDate', 'scac', 'bolNumber', 'loadNumber']);
        safe.review.items = (result.review.items || []).map(item => pick(item, ['line', 'quantity']));
    }
    if (result.erpSource) {
        safe.erpSource = pick(result.erpSource, ['vendor_id', 'vendor_name', 'department', 'invoiceDate']);
        safe.erpSource.destinationCenter = pick(result.erpSource.destinationCenter, addressFields);
        safe.erpSource.load_shipments = (result.erpSource.load_shipments || []).filter(Boolean).map(shipment => ({
            ...pick(shipment, ['created_at']),
            ...(shipment.shipment_tracking ? { shipment_tracking: pick(shipment.shipment_tracking, ['asn_sent_at']) } : {}),
            shipment_notice: pick(shipment.shipment_notice, ['assigned_scac', 'bol']),
            load: pick(shipment.load, ['load_number', 'bol_number']),
        }));
    }
    return safe;
};

module.exports = { invoiceVisibility };
