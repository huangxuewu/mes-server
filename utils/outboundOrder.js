const normalizeText = value => String(value ?? "").trim();

const normalizeStyleCode = value => normalizeText(value).replace(/\D+/g, "");

const normalizeOutboundItems = (items = []) => (Array.isArray(items) ? items : [])
    .map(item => ({
        upc: normalizeText(item?.upc ?? item?.item_bar_code),
        quantity: Number(item?.quantity ?? item?.total_item_qty) || 0,
        casePack: Number(item?.casePack ?? item?.vcp_qty) || 0,
        styleCode: normalizeStyleCode(item?.styleCode ?? item?.external_id),
        description: normalizeText(item?.description ?? item?.item_description),
    }))
    .filter(item => item.quantity > 0);

const validateOutboundItems = (items, poNumber) => {
    const normalized = normalizeOutboundItems(items);
    if (!normalized.length)
        throw new Error(`PO-DC ${poNumber} has no local shippable items`);

    for (const item of normalized) {
        if (!item.styleCode)
            throw new Error(`PO-DC ${poNumber} has an item without a DPCI`);
        if (!(item.casePack > 0))
            throw new Error(`PO-DC ${poNumber} item ${item.styleCode} has an invalid case pack`);
        if (item.quantity % item.casePack !== 0)
            throw new Error(`PO-DC ${poNumber} item ${item.styleCode} is not a whole carton`);
    }

    return normalized;
};

const getCartonCount = items => normalizeOutboundItems(items)
    .reduce((total, item) => total + item.quantity / item.casePack, 0);

const allocationSignature = items => normalizeOutboundItems(items)
    .map(({ upc, quantity, casePack, styleCode }) => ({ upc, quantity, casePack, styleCode }))
    .sort((a, b) => `${a.styleCode}:${a.upc}`.localeCompare(`${b.styleCode}:${b.upc}`));

const allocationsMatch = (left, right) =>
    JSON.stringify(allocationSignature(left)) === JSON.stringify(allocationSignature(right));

const hasPhysicalProgress = load =>
    ["Picked Up", "Completed"].includes(load?.status)
    || Boolean(load?.actualPickupAt)
    || Boolean(load?.bol?.number || load?.bol?.url)
    || Object.values(load?.checklist ?? {}).some(step => step?.status);

const buildOutboundDocument = (order, buyer, items = buyer?.items) => ({
    masterPO: normalizeText(buyer?.masterPO) || normalizeText(order?.poNumber),
    poDate: buyer?.poDate ?? order?.poDate,
    poNumber: normalizeText(buyer?.poNumber),
    client: order?.client || "Target",
    name: buyer?.name,
    address: buyer?.address,
    city: buyer?.city,
    state: buyer?.state,
    zip: buyer?.zip,
    country: buyer?.country,
    shipWindow: buyer?.shipWindow ?? order?.shipWindow,
    items: validateOutboundItems(items, buyer?.poNumber),
});

const prepareOutboundUpdate = (order, buyer, outbound) => {
    const header = buildOutboundDocument(order, buyer);
    const allocationChanged = !allocationsMatch(outbound?.items, header.items);
    const currentLoads = outbound?.loads ?? [];

    if (!allocationChanged) return header;
    if (currentLoads.some(hasPhysicalProgress))
        throw new Error(`PO-DC ${outbound.poNumber} changed in ERP after shipping work started. Its existing shipment was not changed.`);
    if (currentLoads.length > 1)
        throw new Error(`PO-DC ${outbound.poNumber} changed in ERP and has multiple loads. Reallocate it manually before updating the PO.`);
    if (!currentLoads.length) return header;

    const load = currentLoads[0];
    const erpCartons = getCartonCount(header.items);
    const loadCartons = Math.round(Number(load.cartons) || 0);
    if (erpCartons !== loadCartons)
        throw new Error(`PO-DC ${outbound.poNumber} changed to ${erpCartons} cartons in ERP, but load ${load.loadNumber || load.shipmentId} has ${loadCartons}. Sync the revised load before updating the PO.`);

    return {
        ...header,
        loads: [{ ...load, items: header.items }],
    };
};

const prepareShipmentDocuments = order => {
    const buyers = order?.buyers ?? [];
    if (!buyers.length)
        throw new Error(`PO ${order?.poNumber} has no local destinations to ship`);

    return buyers.map(buyer => buildOutboundDocument(order, buyer));
};

module.exports = {
    allocationsMatch,
    buildOutboundDocument,
    getCartonCount,
    hasPhysicalProgress,
    normalizeOutboundItems,
    normalizeStyleCode,
    prepareOutboundUpdate,
    prepareShipmentDocuments,
    validateOutboundItems,
};
