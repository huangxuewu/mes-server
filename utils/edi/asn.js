const { getClient } = require("./client");

// Contract verified against the ERP DMS ASN send page and GraphQL schema, 2026-09-10.
const ASN_QUERY = `query MesAsn($filter: LoadShipmentFilter, $first: Int, $after: String) {
    loadShipment(filter: $filter, first: $first, after: $after) {
        edges { node {
            id po_number load_shipment_notice_id created_at
            load { id load_number bol_number }
            shipment_notice { shipment_id status assigned_scac executing_scac pro cartons department }
            shipment_tracking { is_asn_successfully_sent }
            load_packings { packing_number load_po_items { external_id product { upc } } }
            po {
                po_number vendor_id po_created_at
                addresses { type destination }
                destinationCenter { dc_code dc_name }
                items { external_id item_bar_code vendor_style total_item_qty vcp_qty ssp_qty }
                edi_transaction {
                    id transaction_type business_number created_at validation_status delivery_status acknowledgment_status
                    document { json_data }
                }
            }
        } }
        pageInfo { hasNextPage endCursor }
    }
}`;
const ACCOUNT_QUERY = `query MesAsnAccount($filter: EdiAccountFilter) {
    ediAccounts(first: 2, filter: $filter) { edges { node { isa_id } } }
}`;
const CREATE_ASN = `mutation MesCreateAsn($input: CreateTransactionInput!) {
    createTransaction(input: $input) { id }
}`;
const SAVE_ADJUSTMENTS = `mutation MesAsnAdjustments($input: [LoadShipmentAdjustmentsInput!]!) {
    upsertLoadShipmentAdjustments(input: $input) { id }
}`;
const normalize = value => String(value ?? "").trim();
const identifier = value => normalize(value).replace(/[^0-9A-Za-z]/g, "");
const activeLoads = new Set();
// Retain ambiguous create outcomes until ERP exposes the transaction; never blindly repeat a POST.
const attemptedShipments = new Set();

const transactionState = transaction => {
    if (!transaction) return "missing";
    const validation = normalize(transaction.validation_status).toUpperCase();
    const delivery = normalize(transaction.delivery_status).toUpperCase();
    const acknowledgment = normalize(transaction.acknowledgment_status).toUpperCase();
    if (validation === "INVALID" || delivery === "FAILED" || ["REJECTED", "ACCEPTEDWITHERRORS"].includes(acknowledgment)) return "failed";
    return validation === "VALID" && delivery === "DELIVERED" && ["ACCEPTED", "OVERDUE"].includes(acknowledgment) ? "success" : "pending";
};

const transactionDocument = transaction => {
    const data = transaction?.document?.json_data;
    return (typeof data === "string" ? JSON.parse(data) : data)?.transactionSets?.[0];
};

const asnContents = document => {
    const levels = document?.HL_loop || [];
    return JSON.stringify({
        bol: (levels.find(level => level.hierarchicalLevel?.[0]?.hierarchicalLevelCode === "S")?.referenceInformation || [])
            .filter(reference => ["BM", "MB"].includes(reference.referenceIdentificationQualifier))
            .map(reference => `${reference.referenceIdentificationQualifier}:${reference.referenceIdentification}`).sort(),
        cartons: levels.filter(level => level.hierarchicalLevel?.[0]?.hierarchicalLevelCode === "P").map(level => {
            const id = level.hierarchicalLevel[0].hierarchicalIDNumber;
            const items = levels.filter(item => item.hierarchicalLevel?.[0]?.hierarchicalParentIDNumber === id).map(item => {
                const product = item.itemIdentification?.[0] || {};
                const codes = ["", "1", "2", "3"].map(suffix => `${product[`productServiceIDQualifier${suffix}`] || ""}:${product[`productServiceID${suffix}`] || ""}`).filter(code => code !== ":").sort();
                return `${codes.join(",")}:${Number(item.itemDetailShipment?.[0]?.numberOfUnitsShipped)}:${item.itemDetailShipment?.[0]?.unitOrBasisForMeasurementCode}`;
            }).sort();
            return `${level.marksAndNumbersInformation?.[0]?.marksAndNumbers}:${items.join(";")}`;
        }).sort(),
    });
};

const latestAsn = shipment => (shipment.po?.edi_transaction || [])
    .filter(transaction => transaction.transaction_type === "856"
        && normalize(transactionDocument(transaction)?.beginningSegmentForShipNotice?.[0]?.shipmentIdentification || transaction.business_number) === normalize(shipment.id))
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];

const buildAsn = (shipment, mes, now = new Date()) => {
    const po = shipment.po;
    const notice = shipment.shipment_notice;
    const bolNumber = normalize(mes.bol?.number || mes.bol?.rawData?.bill_of_lading_number);
    if (!/^\d+$/.test(bolNumber)) throw new Error(`PO ${mes.poNumber}: save a numeric MES BOL number first`);
    if (!po || normalize(po.po_number) !== normalize(mes.poNumber)) throw new Error(`PO ${mes.poNumber}: ERP PO does not match`);
    if (!notice || normalize(shipment.load_shipment_notice_id) !== normalize(mes.shipmentId)
        || normalize(notice.shipment_id) !== normalize(mes.shipmentId)) throw new Error(`PO ${mes.poNumber}: ERP shipment mapping does not match`);
    if (normalize(notice.status).toLowerCase() === "cancelled") throw new Error(`PO ${mes.poNumber}: ERP shipment is cancelled`);
    const shipTo = po.destinationCenter;
    const buyer = po.addresses?.find(address => address.type === "BY") || po.addresses?.find(address => address.type === "MF");
    if (!/^\d{4}$/.test(normalize(shipTo?.dc_code)) || !/^\d{4}$/.test(normalize(buyer?.destination)))
        throw new Error(`PO ${mes.poNumber}: ERP requires four-digit ship-to and buying-party locations`);
    if (!notice.assigned_scac || !po.vendor_id || !shipTo.dc_name) throw new Error(`PO ${mes.poNumber}: ERP carrier, vendor or destination is missing`);
    const consolidated = ["SCII", "SQKO"].includes(notice.assigned_scac);
    const method = consolidated && notice.pro ? "C" : notice.executing_scac ? "U" : "M";
    const carrier = method === "C" ? "Southeast Consolidators - GA" : method === "U" ? "CH Robinson"
        : mes.bol?.rawData?.carrier_name || mes.carrierContact?.name || notice.assigned_scac;
    const scac = consolidated ? "SOCS" : notice.assigned_scac;
    const quantities = new Map();
    if (!Array.isArray(mes.items) || !mes.items.length) throw new Error(`PO ${mes.poNumber}: MES sending quantities are missing`);
    for (const item of mes.items) {
        const quantity = Number(item.quantity) - Number(item.backorder ?? 0);
        if (!Number.isSafeInteger(quantity) || quantity < 0) throw new Error(`PO ${mes.poNumber}: invalid sending quantity for ${item.styleCode}`);
        if (!quantity) continue;
        const matches = (po.items || []).filter(candidate =>
            (normalize(item.upc) && normalize(candidate.item_bar_code) === normalize(item.upc))
            || (normalize(item.styleCode) && normalize(candidate.vendor_style) === normalize(item.styleCode)));
        const ids = [...new Set(matches.map(candidate => candidate.external_id))];
        if (ids.length !== 1) throw new Error(`PO ${mes.poNumber}: cannot uniquely match item ${item.styleCode || item.upc} in ERP`);
        const matchingItems = matches.filter(candidate => candidate.external_id === ids[0]);
        if (matchingItems.some(candidate => Number(candidate.vcp_qty) !== Number(item.casePack)))
            throw new Error(`PO ${mes.poNumber}: MES and ERP case packs differ for ${item.styleCode}`);
        quantities.set(ids[0], (quantities.get(ids[0]) || 0) + quantity);
    }
    if (!quantities.size) throw new Error(`PO ${mes.poNumber}: no sending quantity`);

    const previousQuantities = new Map();
    const countedTransactions = new Set();
    for (const transaction of po.edi_transaction || []) {
        if (transaction.transaction_type !== "856" || transactionState(transaction) !== "success") continue;
        if (countedTransactions.has(normalize(transaction.id))) continue;
        countedTransactions.add(normalize(transaction.id));
        const document = transactionDocument(transaction);
        if (normalize(document?.beginningSegmentForShipNotice?.[0]?.shipmentIdentification || transaction.business_number) === normalize(shipment.id)) continue;
        for (const level of document?.HL_loop || []) {
            if (level.hierarchicalLevel?.[0]?.hierarchicalLevelCode !== "I") continue;
            const item = level.itemIdentification?.[0] || {};
            const codes = ["", "1", "2", "3"].map(suffix => ({ qualifier: item[`productServiceIDQualifier${suffix}`], value: item[`productServiceID${suffix}`] }));
            const code = codes.find(code => code.qualifier === "CB") || codes.find(code => code.qualifier === "IN") || codes[0];
            const id = identifier(code.value);
            previousQuantities.set(id, (previousQuantities.get(id) || 0) + Number(level.itemDetailShipment?.[0]?.numberOfUnitsShipped || 0));
        }
    }
    const levels = [{
        hierarchicalLevel: [{ hierarchicalIDNumber: "1", hierarchicalParentIDNumber: "0", hierarchicalLevelCode: "S" }],
        carrierDetailsRoutingSequenceTransitTime: [{ routingSequenceCode: "B", identificationCodeQualifier: "2", identificationCode: scac, transportationMethodTypeCode: method, routing: carrier }],
        referenceInformation: ["MB", "BM"].map(qualifier => ({ referenceIdentificationQualifier: qualifier, referenceIdentification: bolNumber })),
        N1_loop: [{ partyIdentification: [{ entityIdentifierCode: "ST", name: shipTo.dc_name, identificationCodeQualifier: "92", identificationCode: normalize(shipTo.dc_code) }] }],
    }, {
        hierarchicalLevel: [{ hierarchicalIDNumber: "2", hierarchicalParentIDNumber: "1", hierarchicalLevelCode: "O" }],
        purchaseOrderReference: [{ purchaseOrderNumber: po.po_number }],
        productItemDescription: [{ itemDescriptionTypeCode: "S", agencyQualifierCode: "VI", productDescriptionCode: "FL" }],
        carrierDetailsQuantityAndWeight: [{ packagingCode: "CTN25", ladingQuantity: "0" }],
        N1_loop: [{ partyIdentification: [{ entityIdentifierCode: buyer.type, identificationCodeQualifier: "92", identificationCode: normalize(buyer.destination) }] }],
    }];
    const seenPackings = new Set();
    const remainingQuantities = new Map();
    let itemNumber = 0;
    for (const [externalId, quantity] of quantities) {
        const items = po.items.filter(item => item.external_id === externalId);
        const item = items[0];
        const casePack = Number(item.vcp_qty);
        if (!Number.isSafeInteger(casePack) || casePack <= 0 || quantity % casePack)
            throw new Error(`PO ${mes.poNumber}: ${externalId} must ship in full cartons`);
        const remaining = items.reduce((sum, row) => sum + Number(row.total_item_qty), 0) - (previousQuantities.get(identifier(externalId)) || 0);
        remainingQuantities.set(externalId, remaining);
        if (!Number.isFinite(remaining) || quantity > remaining) throw new Error(`PO ${mes.poNumber}: ${externalId} exceeds the remaining ERP quantity`);
        const packings = (shipment.load_packings || []).filter(packing => packing.load_po_items?.[0]?.external_id === externalId);
        if (packings.length < quantity / casePack) throw new Error(`PO ${mes.poNumber}: insufficient ERP carton labels for ${externalId}`);
        itemNumber++;
        for (const packing of packings.slice(0, quantity / casePack)) {
            const packingNumber = normalize(packing.packing_number);
            if (!packingNumber || seenPackings.has(packingNumber) || packing.load_po_items.length !== 1) throw new Error(`PO ${mes.poNumber}: invalid or duplicate ERP carton label`);
            seenPackings.add(packingNumber);
            const upc = normalize(item.item_bar_code || packing.load_po_items[0]?.product?.upc);
            if (!upc) throw new Error(`PO ${mes.poNumber}: missing UPC for ${externalId}`);
            const parent = String(levels.length + 1);
            levels.push({
                hierarchicalLevel: [{ hierarchicalIDNumber: parent, hierarchicalParentIDNumber: "2", hierarchicalLevelCode: "P" }],
                marksAndNumbersInformation: [{ marksAndNumbersQualifier: "GM", marksAndNumbers: packingNumber }],
            }, {
                hierarchicalLevel: [{ hierarchicalIDNumber: String(levels.length + 2), hierarchicalParentIDNumber: parent, hierarchicalLevelCode: "I" }],
                itemIdentification: [{ assignedIdentification: String(itemNumber), productServiceIDQualifier: "UP", productServiceID: upc, productServiceIDQualifier1: "CB", productServiceID1: identifier(externalId) }],
                itemDetailShipment: [{ numberOfUnitsShipped: String(casePack), unitOrBasisForMeasurementCode: "EA" }],
                itemPhysicalDetails: [{ pack: String(casePack), ...(item.ssp_qty && item.ssp_qty !== item.vcp_qty ? { innerPack: String(item.ssp_qty) } : {}) }],
            });
        }
    }
    const cartons = seenPackings.size;
    levels[1].carrierDetailsQuantityAndWeight[0].ladingQuantity = String(cartons);
    const dateParts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now).map(part => [part.type, part.value]));
    const message = { transactionSets: [{
        transactionSetHeader: [{ transactionSetIdentifierCode: "856", transactionSetControlNumber: "0001" }],
        beginningSegmentForShipNotice: [{ transactionSetPurposeCode: "00", shipmentIdentification: String(shipment.id), date: `${dateParts.year}${dateParts.month}${dateParts.day}`, time: `${dateParts.hour}${dateParts.minute}`, hierarchicalStructureCode: "0001" }],
        HL_loop: levels, transactionTotals: [{ numberOfLineItems: String(levels.length) }],
    }] };
    const adjustments = [...new Set(po.items.map(item => item.external_id))].flatMap(externalId => {
        const notifyQuantity = po.items.filter(item => item.external_id === externalId).reduce((sum, item) => sum + Number(item.total_item_qty), 0);
        const quantity = quantities.get(externalId) || 0;
        return quantity === notifyQuantity ? [] : [{
            external_id: externalId, actual_shipped_quantity: quantity, notify_quantity: notifyQuantity,
            po_number: po.po_number, load_shipment_notice_id: shipment.load_shipment_notice_id,
            scac_code: scac, carrier_name: carrier, carriers_reference_number: mes.loadNumber,
            bol_number: bolNumber, lading_qty: cartons, send_date: now.toISOString(), shipped_date: now.toISOString(),
            transportation_method_type: method, purpose: "00",
        }];
    });
    return { message, adjustments, bolNumber, quantities, remainingQuantities };
};

const submitAsns = async ({ shipments, retryShipmentId }, { clientFactory = getClient, onProgress = () => {} } = {}) => {
    if (!shipments?.length) throw new Error("No loaded shipments selected");
    const loadNumber = normalize(shipments[0].loadNumber);
    if (!/^\d+$/.test(loadNumber) || shipments.some(shipment => normalize(shipment.loadNumber) !== loadNumber)) throw new Error("Invalid MES load selection");
    const selected = retryShipmentId === undefined ? shipments : shipments.filter(shipment => shipment.shipmentId === retryShipmentId);
    if (!selected.length || (retryShipmentId !== undefined && selected.length !== 1)) throw new Error('Retry shipment must belong uniquely to the selected load');
    const client = await clientFactory();
    const key = `${client.config.baseUrl}:${client.headers["x-tenant-id"] || ""}:${loadNumber}`;
    if (activeLoads.has(key)) throw new Error("ASN submission is already running for this load");
    activeLoads.add(key);
    try {
        onProgress({ phase: 'preparing', poNumber: selected[0].poNumber, shipmentId: selected[0].shipmentId });
        const rows = [];
        let after;
        do {
            const data = await client.graphql(ASN_QUERY, { filter: { load: { load_number: { eq: loadNumber } } }, first: 100, after });
            const connection = data?.loadShipment;
            if (!connection) throw new Error("ERP did not return load shipments");
            rows.push(...connection.edges.map(edge => edge.node));
            const next = connection.pageInfo?.hasNextPage ? connection.pageInfo.endCursor : null;
            if (next && next === after) throw new Error("ERP shipment pagination did not advance");
            after = next;
        } while (after);
        // Validate every selected PO before creating the first transaction.
        const plans = selected.map(mes => {
            onProgress({ phase: 'preparing', poNumber: mes.poNumber, shipmentId: mes.shipmentId });
            if (!mes.checklist?.loaded?.status || !mes.bol?.url) throw new Error(`PO ${mes.poNumber}: load and upload the MES BOL first`);
            const matches = rows.filter(row => normalize(row.load_shipment_notice_id) === normalize(mes.shipmentId) && normalize(row.po?.po_number) === normalize(mes.poNumber));
            if (matches.length !== 1) throw new Error(`PO ${mes.poNumber}: expected one matching ERP shipment, found ${matches.length}`);
            const shipment = matches[0];
            const transaction = latestAsn(shipment);
            const plan = { mes, shipment, transaction, ...buildAsn(shipment, mes), attemptKey: `${key}:${shipment.id}` };
            if (transaction && transactionState(transaction) !== "failed") {
                const existing = transactionDocument(transaction);
                if (!existing || asnContents(existing) !== asnContents(plan.message.transactionSets[0]))
                    throw new Error(`PO ${mes.poNumber}: an existing ASN has different BOL or quantities; review it in ERP`);
            } else if (shipment.shipment_tracking?.is_asn_successfully_sent) {
                throw new Error(`PO ${mes.poNumber}: ERP marks ASN as sent but its transaction cannot be verified`);
            }
            if ((!transaction || transactionState(transaction) === 'failed') && attemptedShipments.has(plan.attemptKey)) throw new Error(`PO ${mes.poNumber}: previous ASN outcome is unknown; check ERP before resending`);
            if (!transaction && poChanged(shipment)) throw new Error(`PO ${mes.poNumber}: ERP PO changed after the load was created; review ASN in ERP`);
            return plan;
        });
        if (new Set(plans.map(plan => plan.shipment.id)).size !== plans.length) throw new Error("Duplicate shipment selection");
        if (new Set(plans.map(plan => plan.bolNumber)).size !== 1) throw new Error("Selected shipments must share the same MES BOL number");
        if (new Set(plans.map(plan => plan.shipment.load.id)).size !== 1) throw new Error("Selected shipments belong to different ERP loads");
        const totals = new Map();
        for (const plan of plans.filter(plan => transactionState(plan.transaction) !== "success")) {
            for (const [externalId, quantity] of plan.quantities) {
                const itemKey = `${plan.mes.poNumber}:${externalId}`;
                const total = (totals.get(itemKey) || 0) + quantity;
                if (total > plan.remainingQuantities.get(externalId)) throw new Error(`PO ${plan.mes.poNumber}: selected shipments together exceed the remaining ERP quantity for ${externalId}`);
                totals.set(itemKey, total);
            }
        }
        for (const plan of plans) {
            if (plan.transaction && transactionState(plan.transaction) !== "failed") continue;
            onProgress({ phase: 'preparing', poNumber: plan.mes.poNumber, shipmentId: plan.mes.shipmentId });
            const data = await client.graphql(ACCOUNT_QUERY, { filter: { vendor_id: { eq: plan.shipment.po.vendor_id } } });
            const accounts = data?.ediAccounts?.edges || [];
            const isaId = accounts.length === 1 ? normalize(accounts[0].node.isa_id) : "";
            if (!isaId.endsWith("DMS")) throw new Error(`PO ${plan.mes.poNumber}: expected one domestic ERP EDI account`);
            plan.accountCode = "Domestic";
        }
        for (const plan of plans) {
            onProgress({ phase: 'submitting', poNumber: plan.mes.poNumber, shipmentId: plan.mes.shipmentId });
            if (!plan.transaction || transactionState(plan.transaction) === "failed") {
                const current = await client.graphql(ASN_QUERY, { filter: { id: { eq: Number(plan.shipment.id) } }, first: 1 });
                const shipment = current?.loadShipment?.edges?.[0]?.node;
                if (!shipment || poChanged(shipment)) throw new Error(`PO ${plan.mes.poNumber}: ERP shipment changed; review it before sending`);
                const refreshed = buildAsn(shipment, plan.mes);
                const transaction = latestAsn(shipment);
                if (transaction && transactionState(transaction) !== "failed") {
                    if (asnContents(transactionDocument(transaction)) !== asnContents(refreshed.message.transactionSets[0])) throw new Error(`PO ${plan.mes.poNumber}: a different ASN was submitted in ERP`);
                    plan.transaction = transaction;
                } else {
                    if (shipment.shipment_tracking?.is_asn_successfully_sent) throw new Error(`PO ${plan.mes.poNumber}: ASN was already sent in ERP`);
                    attemptedShipments.add(plan.attemptKey);
                    const result = await client.graphql(CREATE_ASN, { input: { account_code: plan.accountCode, message: refreshed.message, stream: "LIVE", type: "SHIP_NOTICE_MANIFEST_856" } });
                    if (!result?.createTransaction?.id) throw new Error(`PO ${plan.mes.poNumber}: ERP did not return an ASN transaction ID; check ERP before resending`);
                    attemptedShipments.delete(plan.attemptKey);
                    plan.transaction = { id: result.createTransaction.id };
                }
            }
            if (plan.adjustments.length) await client.graphql(SAVE_ADJUSTMENTS, { input: plan.adjustments });
            // ERP receipt completes submission; delivery and partner acknowledgement continue in ERP.
            onProgress({ phase: 'received', poNumber: plan.mes.poNumber, shipmentId: plan.mes.shipmentId, transactionId: plan.transaction.id });
        }
        return { transactions: plans.map(plan => ({ shipmentId: plan.mes.shipmentId, poNumber: plan.mes.poNumber, id: plan.transaction.id })) };
    } finally {
        activeLoads.delete(key);
    }
};

const poChanged = shipment => shipment.po?.po_created_at && shipment.created_at && new Date(shipment.po.po_created_at) > new Date(shipment.created_at);

module.exports = { ASN_QUERY, ACCOUNT_QUERY, CREATE_ASN, SAVE_ADJUSTMENTS, buildAsn, transactionState, latestAsn, submitAsns };
