const { getClient } = require("./client");
const { findShipmentForLabel, findShipments } = require("./shipments");

const SHIP_FROM = {
    name: "Down Home Manufacturing LLC",
    address1: "402 Maxwell Ave",
    city: "Greenwood",
    state: "SC",
    zip: "29646",
};

const LABEL_TYPE = "TARGET_REGIONAL_DISTRIBUTION_CENTER_ORDER_SINGLE_CARTON";

const normalize = value => String(value ?? "").trim();

const formatSscc18 = (packingNumber) => {
    const raw = normalize(packingNumber);
    if (raw.length < 3) throw new Error(`Invalid packing_number: ${raw}`);
    return `(${raw.substring(0, 2)})${raw.substring(2)}`;
};

const resolveShipTo = (po) => {
    const dc = po?.destinationCenter;
    if (dc?.dc_name || dc?.address_line) {
        return {
            name: normalize(dc.dc_name),
            address1: normalize(dc.address_line),
            city: normalize(dc.city),
            state: normalize(dc.state),
            zip: normalize(dc.zip_code),
        };
    }

    const address = (po?.addresses || []).find(a => /st/i.test(normalize(a?.type)));
    if (!address) return null;

    return {
        name: normalize(address.name || address.contact_name),
        address1: normalize(address.address),
        city: normalize(address.city),
        state: normalize(address.state),
        zip: normalize(address.postal_code),
    };
};

const validateShipment = (shipment) => {
    if (!shipment) throw Object.assign(new Error("Shipment not found"), { status: 404 });

    const po = shipment.po;
    if (!po) throw Object.assign(new Error("PO data is missing on EDI shipment"), { status: 422 });

    const shipTo = resolveShipTo(po);
    if (!shipTo?.name || !shipTo?.address1 || !shipTo?.city || !shipTo?.state || !shipTo?.zip)
        throw Object.assign(new Error("Destination data is missing on EDI shipment"), { status: 422 });

    const packings = shipment.load_packings || [];
    if (!packings.length)
        throw Object.assign(new Error("No load packings found on EDI shipment"), { status: 422 });

    const packingNumbers = packings.map(p => normalize(p?.packing_number));
    if (packingNumbers.some(n => !n))
        throw Object.assign(new Error("Every packing must have a packing_number"), { status: 422 });

    if (new Set(packingNumbers).size !== packingNumbers.length)
        throw Object.assign(new Error("Duplicate packing_number values found"), { status: 422 });

    const cartons = shipment.shipment_notice?.cartons;
    if (Number.isFinite(Number(cartons))) {
        const expected = Math.round(Number(cartons));
        if (expected !== packings.length) {
            throw Object.assign(
                new Error(`Carton count mismatch: ShipIQ ${expected}, EDI packings ${packings.length}`),
                {
                    status: 409,
                    code: "CARTON_MISMATCH",
                    shipIqCartons: expected,
                    loadPackings: packings.length,
                }
            );
        }
    }

    const poItems = po.items || [];
    for (const packing of packings) {
        const externalId = normalize(packing?.load_po_items?.[0]?.external_id);
        if (!externalId)
            throw Object.assign(new Error("Packing is missing load_po_items.external_id"), { status: 422 });

        const poItem = poItems.find(item => normalize(item?.external_id) === externalId);
        if (!poItem)
            throw Object.assign(new Error(`No PO item found for external_id ${externalId}`), { status: 422 });
    }

    return { po, shipTo, packings, poItems };
};

const buildLabelPayload = (shipment) => {
    const { po, shipTo, packings, poItems } = validateShipment(shipment);
    const carrierName = normalize(shipment.shipment_notice?.assigned_scac) || "UNKNOWN";
    const poNumber = normalize(po.po_number || shipment.po_number);

    const labels = packings.map((packing) => {
        const externalId = normalize(packing.load_po_items[0].external_id);
        const poItem = poItems.find(item => normalize(item.external_id) === externalId);

        return {
            type: LABEL_TYPE,
            shipFrom: SHIP_FROM,
            shipTo,
            carrier: { name: carrierName },
            shipment: { "sscc-18": formatSscc18(packing.packing_number) },
            case: { pack: poItem.vcp_qty || 0 },
            item: {
                buyerPartNumber: externalId.replace(/-/g, ""),
                style: normalize(poItem.vendor_style),
                description: normalize(poItem.item_description),
                upcNumber: normalize(poItem.item_bar_code),
            },
            purchaseOrder: { number: poNumber },
        };
    });

    return {
        labels,
        options: {
            format: "pdf",
            skipValidation: true,
        },
    };
};

const generateShippingLabelPdf = async ({ loadNumber, poDc } = {}) => {
    const match = await findShipmentForLabel({ loadNumber, poDc });
    const payload = buildLabelPayload(match.node);
    const client = await getClient();
    const pdf = await client.generateLabels(payload);

    return {
        pdf,
        filename: `shipping-label-${loadNumber}-${poDc || match.poDc}.pdf`,
        shipment: {
            loadNumber: match.loadNumber,
            poDc: match.poDc,
            shipmentDocumentId: match.shipmentDocumentId,
            shipmentId: match.shipmentId,
        },
    };
};

const generateShippingLabelsPdf = async ({ loadNumber, poDc, poDcs } = {}) => {
    const targets = poDcs?.length
        ? poDcs.map(normalize).filter(Boolean)
        : poDc
            ? [normalize(poDc)]
            : [];

    if (!targets.length)
        return generateShippingLabelPdf({ loadNumber, poDc });

    if (targets.length === 1)
        return generateShippingLabelPdf({ loadNumber, poDc: targets[0] });

    // Multi PO-DC: combine all carton labels into one EDI request
    const matches = await findShipments({ loadNumber });
    const selected = matches.filter(m => targets.includes(m.poDc));

    if (!selected.length)
        throw Object.assign(new Error(`No EDI shipments found for load ${loadNumber} with requested PO-DCs`), { status: 404 });

    if (selected.length !== targets.length) {
        const found = new Set(selected.map(s => s.poDc));
        const missing = targets.filter(t => !found.has(t));
        throw Object.assign(new Error(`Missing EDI shipments for PO-DCs: ${missing.join(", ")}`), { status: 404 });
    }

    const labels = [];
    for (const match of selected) {
        const payload = buildLabelPayload(match.node);
        labels.push(...payload.labels);
    }

    const client = await getClient();
    const pdf = await client.generateLabels({
        labels,
        options: { format: "pdf", skipValidation: true },
    });

    return {
        pdf,
        filename: `shipping-label-${loadNumber}.pdf`,
        shipment: {
            loadNumber: normalize(loadNumber),
            poDcs: targets,
        },
    };
};

module.exports = {
    SHIP_FROM,
    LABEL_TYPE,
    formatSscc18,
    resolveShipTo,
    validateShipment,
    buildLabelPayload,
    generateShippingLabelPdf,
    generateShippingLabelsPdf,
};
