const test = require("node:test");
const assert = require("node:assert/strict");
const clientPath = require.resolve("../utils/edi/client");
require.cache[clientPath] = { id: clientPath, filename: clientPath, loaded: true, exports: {} };
const { buildAsn, transactionState, submitAsns, ASN_QUERY, ACCOUNT_QUERY, CREATE_ASN, SAVE_ADJUSTMENTS } = require("../utils/edi/asn");

const fixture = (loadNumber = "1234") => {
    const mes = { loadNumber, shipmentId: "SHIP1", poNumber: "PO-0555", checklist: { loaded: { status: true } },
        bol: { number: "84017971234567890", url: "https://www.dropbox.com/bol", rawData: { carrier_name: "Test Carrier" } },
        items: [{ styleCode: "PILLOW", upc: "012345678901", quantity: 12, backorder: 4, casePack: 4 }] };
    const shipment = { id: 1, load_shipment_notice_id: "SHIP1", load: { id: 20, load_number: loadNumber, bol_number: "ERP-OLD" },
        shipment_notice: { shipment_id: "SHIP1", assigned_scac: "TEST", status: "Carrier Accepted", cartons: 3 },
        shipment_tracking: {}, load_packings: ["001", "002", "003"].map(packing_number => ({ packing_number, load_po_items: [{ external_id: "062-01-1234" }] })),
        po: { po_number: "PO-0555", vendor_id: "vendor", addresses: [{ type: "BY", destination: "0555" }],
            destinationCenter: { dc_code: "0555", dc_name: "Target DC" },
            items: [{ external_id: "062-01-1234", item_bar_code: "012345678901", vendor_style: "PILLOW", vcp_qty: 4, ssp_qty: 2, total_item_qty: 12 }], edi_transaction: [] } };
    return { mes, shipment };
};
const successful = { validation_status: "VALID", delivery_status: "DELIVERED", acknowledgment_status: "ACCEPTED" };

test("ASN uses MES BOL, actual units after backorders, ERP SSCCs and Central time", () => {
    const { mes, shipment } = fixture();
    const { message, adjustments } = buildAsn(shipment, mes, new Date("2026-09-10T01:30:00Z"));
    const document = message.transactionSets[0];
    assert.equal(document.beginningSegmentForShipNotice[0].date, "20260909");
    assert.equal(document.beginningSegmentForShipNotice[0].time, "2030");
    assert.equal(document.beginningSegmentForShipNotice[0].shipmentIdentification, "1");
    assert.deepEqual(document.HL_loop[0].referenceInformation.map(item => item.referenceIdentification), [mes.bol.number, mes.bol.number]);
    const items = document.HL_loop.filter(level => level.hierarchicalLevel[0].hierarchicalLevelCode === "I");
    assert.equal(items.length, 2);
    assert.equal(items.reduce((sum, item) => sum + Number(item.itemDetailShipment[0].numberOfUnitsShipped), 0), 8);
    assert.deepEqual(document.HL_loop.map(level => level.hierarchicalLevel[0].hierarchicalIDNumber), ["1", "2", "3", "4", "5", "6"]);
    assert.equal(document.HL_loop[1].carrierDetailsQuantityAndWeight[0].ladingQuantity, "2");
    assert.equal(adjustments[0].actual_shipped_quantity, 8);
    assert.equal(adjustments[0].notify_quantity, 12);
});

test("mapping, quantities, case packs, labels, cancelled notices and missing BOL fail closed", () => {
    for (const [mutate, error] of [
        [(m, s) => { s.load_shipment_notice_id = "wrong"; }, /mapping/],
        [(m, s) => { s.shipment_notice.status = "Cancelled"; }, /cancelled/],
        [m => { m.items[0].quantity = 7; }, /full cartons/],
        [m => { m.items[0].quantity = -1; }, /invalid sending/],
        [m => { m.items[0].casePack = 8; }, /case packs differ/],
        [m => { m.items[0].styleCode = "OTHER"; m.items[0].upc = "OTHER"; }, /uniquely match/],
        [(m, s) => { s.load_packings = []; }, /insufficient/],
        [(m, s) => { s.load_packings[1].packing_number = "001"; }, /duplicate/],
        [m => { m.bol.number = ""; }, /MES BOL/],
    ]) {
        const { mes, shipment } = fixture(); mutate(mes, shipment);
        assert.throws(() => buildAsn(shipment, mes), error);
    }
});

test("remaining PO quantity accounts for prior accepted ASN", () => {
    const { mes, shipment } = fixture();
    const previous = buildAsn({ ...shipment, id: 99 }, mes).message;
    shipment.po.edi_transaction.push({ id: "previous", transaction_type: "856", ...successful, document: { json_data: previous } });
    assert.throws(() => buildAsn(shipment, mes), /remaining ERP quantity/);
});

test("ERP status semantics include overdue acceptance and reject accepted-with-errors", () => {
    assert.equal(transactionState(successful), "success");
    assert.equal(transactionState({ ...successful, acknowledgment_status: "OVERDUE" }), "success");
    assert.equal(transactionState({ ...successful, acknowledgment_status: "ACCEPTEDWITHERRORS" }), "failed");
    assert.equal(transactionState({ id: 1 }), "pending");
});

const transport = (loadNumber, { adjustmentFailure = false, createFailure = false, pending = false } = {}) => {
    const { mes, shipment } = fixture(loadNumber);
    const calls = [];
    const client = {
        config: { baseUrl: "https://erp.test" }, headers: { "x-tenant-id": "DMS" },
        async graphql(query, variables) {
            calls.push({ query, variables });
            if (query === ASN_QUERY) return { loadShipment: { edges: [{ node: structuredClone(shipment) }], pageInfo: { hasNextPage: false } } };
            if (query === ACCOUNT_QUERY) return { ediAccounts: { edges: [{ node: { isa_id: "TESTDMS" } }] } };
            if (query === CREATE_ASN) {
                if (createFailure) throw new Error("Network response lost");
                shipment.po.edi_transaction.push({ id: "transaction1", transaction_type: "856", business_number: "1", created_at: new Date().toISOString(),
                    ...(pending ? {} : successful), document: { json_data: variables.input.message } });
                return { createTransaction: { id: "transaction1" } };
            }
            if (query === SAVE_ADJUSTMENTS) {
                if (adjustmentFailure) { adjustmentFailure = false; throw new Error("ERP adjustments failed"); }
                return { upsertLoadShipmentAdjustments: [{ id: 1 }] };
            }
            throw new Error("Unexpected GraphQL request");
        },
        async uploadBol(bytes, load, bol) {
            calls.push({ query: "upload", bytes, load, bol });
            throw new Error("ASN submission must not upload the BOL to ERP");
        },
    };
    return { mes, shipment, calls, client, options: { clientFactory: async () => client } };
};

test("ASN receipt finishes after quantity adjustments without uploading the PDF or updating the ERP load", async () => {
    const f = transport("2001");
    const progress = [];
    const result = await submitAsns({ shipments: [f.mes] }, { ...f.options, onProgress: value => progress.push(value) });
    const operations = f.calls.map(call => call.query);
    assert.ok(operations.indexOf(CREATE_ASN) < operations.indexOf(SAVE_ADJUSTMENTS));
    assert.equal(operations.at(-1), SAVE_ADJUSTMENTS);
    assert.ok(!operations.includes("upload"));
    assert.equal(result.transactions[0].id, "transaction1");
    assert.ok(progress.some(value => value.phase === 'submitting' && value.poNumber === f.mes.poNumber));
    assert.ok(progress.some(value => value.phase === 'received' && value.poNumber === f.mes.poNumber && value.shipmentId === f.mes.shipmentId && value.transactionId === 'transaction1'));
    assert.equal(progress.at(-1).phase, 'received');
    assert.equal(operations.filter(query => query === ASN_QUERY).length, 2);
    assert.equal(f.calls.find(call => call.query === CREATE_ASN).variables.input.stream, "LIVE");
});

test("failed quantity adjustments can retry without resending an accepted ASN", async () => {
    const f = transport("2002", { adjustmentFailure: true });
    await assert.rejects(submitAsns({ shipments: [f.mes] }, f.options), /ERP adjustments failed/);
    await submitAsns({ shipments: [f.mes] }, f.options);
    assert.equal(f.calls.filter(call => call.query === CREATE_ASN).length, 1);
    assert.equal(f.calls.filter(call => call.query === "upload").length, 0);
});

test("ERP receipt finishes while validation, delivery and partner acknowledgement are pending", async () => {
    const f = transport("2003", { pending: true });
    const result = await submitAsns({ shipments: [f.mes] }, f.options);
    assert.equal(result.transactions[0].id, "transaction1");
    assert.equal(result.transactions[0].shipmentId, f.mes.shipmentId);
    assert.equal(transactionState(f.shipment.po.edi_transaction[0]), "pending");
    assert.equal(f.calls.filter(call => call.query === CREATE_ASN).length, 1);
    assert.equal(f.calls.filter(call => call.query === "upload").length, 0);
});

test("uncertain creation is not repeated when ERP has not exposed its outcome", async () => {
    const f = transport("2004", { createFailure: true });
    await assert.rejects(submitAsns({ shipments: [f.mes] }, f.options), /response lost/);
    await assert.rejects(submitAsns({ shipments: [f.mes] }, f.options), /outcome is unknown/);
    assert.equal(f.calls.filter(call => call.query === CREATE_ASN).length, 1);
    assert.equal(f.calls.filter(call => call.query === "upload").length, 0);
});

test("missing ERP transaction ID cannot be treated as receipt", async () => {
    const f = transport("2010");
    const graphql = f.client.graphql;
    f.client.graphql = (query, variables) => query === CREATE_ASN ? { createTransaction: null } : graphql(query, variables);
    const progress = [];
    await assert.rejects(submitAsns({ shipments: [f.mes] }, { ...f.options, onProgress: value => progress.push(value) }), /transaction ID/);
    assert.ok(!progress.some(value => value.phase === 'received'));
    assert.equal(f.calls.filter(call => call.query === "upload").length, 0);
});

test("validate all loaded POs before any create, and detect conflicting existing ASN", async () => {
    const f = transport("2005");
    await assert.rejects(submitAsns({ shipments: [f.mes, { ...f.mes, shipmentId: "missing" }] }, f.options), /matching ERP shipment/);
    assert.equal(f.calls.filter(call => call.query === CREATE_ASN).length, 0);
    await submitAsns({ shipments: [f.mes] }, f.options);
    f.mes.bol.number = "99999";
    await assert.rejects(submitAsns({ shipments: [f.mes] }, f.options), /different BOL or quantities/);
    assert.equal(f.calls.filter(call => call.query === CREATE_ASN).length, 1);
});

test("multiple loaded POs each receive an ASN without uploading the BOL to ERP", async () => {
    const first = fixture("3001"), second = fixture("3001");
    second.mes.shipmentId = "SHIP2";
    second.mes.poNumber = "PO-0666";
    second.shipment.id = 2;
    second.shipment.load_shipment_notice_id = "SHIP2";
    second.shipment.shipment_notice.shipment_id = "SHIP2";
    second.shipment.po.po_number = "PO-0666";
    const rows = [first.shipment, second.shipment];
    const created = [], uploaded = [];
    const client = {
        config: { baseUrl: "https://erp.test" }, headers: {},
        async graphql(query, variables) {
            if (query === ASN_QUERY) return { loadShipment: { edges: rows.filter(row => !variables.filter.id || row.id === variables.filter.id.eq).map(node => ({ node })), pageInfo: {} } };
            if (query === ACCOUNT_QUERY) return { ediAccounts: { edges: [{ node: { isa_id: "TESTDMS" } }] } };
            if (query === CREATE_ASN) {
                const id = variables.input.message.transactionSets[0].beginningSegmentForShipNotice[0].shipmentIdentification;
                const row = rows.find(row => String(row.id) === id);
                created.push(id);
                row.po.edi_transaction.push({ id: `transaction${id}`, transaction_type: "856", business_number: id, ...successful, document: { json_data: variables.input.message } });
                return { createTransaction: { id: `transaction${id}` } };
            }
            if (query === SAVE_ADJUSTMENTS) return {};
        },
        async uploadBol(...args) { uploaded.push(args); },
    };
    const result = await submitAsns({ shipments: [first.mes, second.mes] }, { clientFactory: async () => client });
    assert.deepEqual(created, ["1", "2"]);
    assert.equal(uploaded.length, 0);
    assert.equal(result.transactions.length, 2);
});

test("unloaded shipments and missing MES BOL links cannot reach ERP writes", async () => {
    const f = transport("3002");
    f.mes.checklist.loaded.status = false;
    await assert.rejects(submitAsns({ shipments: [f.mes] }, f.options), /load and upload/);
    f.mes.checklist.loaded.status = true;
    f.mes.bol.url = "";
    await assert.rejects(submitAsns({ shipments: [f.mes] }, f.options), /load and upload/);
    assert.equal(f.calls.filter(call => call.query === CREATE_ASN || call.query === "upload").length, 0);
});

test("row retries create only the selected PO and return its receipt without a BOL step", async () => {
    const first = fixture('4001'), second = fixture('4001');
    second.mes.shipmentId = 'SHIP2';
    second.mes.poNumber = 'PO-0666';
    second.shipment.id = 2;
    second.shipment.load_shipment_notice_id = 'SHIP2';
    second.shipment.shipment_notice.shipment_id = 'SHIP2';
    second.shipment.po.po_number = 'PO-0666';
    const rows = [first.shipment, second.shipment], created = [], uploads = [];
    const client = {
        config: { baseUrl: 'https://erp.test' }, headers: {},
        async graphql(query, variables) {
            if (query === ASN_QUERY) return { loadShipment: { edges: rows.filter(row => !variables.filter.id || row.id === variables.filter.id.eq).map(node => ({ node: structuredClone(node) })), pageInfo: {} } };
            if (query === ACCOUNT_QUERY) return { ediAccounts: { edges: [{ node: { isa_id: 'TESTDMS' } }] } };
            if (query === CREATE_ASN) {
                const id = variables.input.message.transactionSets[0].beginningSegmentForShipNotice[0].shipmentIdentification;
                created.push(id);
                rows.find(row => String(row.id) === id).po.edi_transaction.push({ id: `t${id}`, transaction_type: '856', business_number: id, document: { json_data: variables.input.message } });
                return { createTransaction: { id: `t${id}` } };
            }
            if (query === SAVE_ADJUSTMENTS) return {};
            throw new Error('Unexpected query');
        },
        async uploadBol(...args) { uploads.push(args); },
    };
    const request = { shipments: [first.mes, second.mes] };
    const options = { clientFactory: async () => client };
    // An invalid other PO must not prevent retrying the selected PO.
    second.mes.items[0].quantity = -1;
    const firstResult = await submitAsns({ ...request, retryShipmentId: 'SHIP1' }, options);
    assert.deepEqual(firstResult.transactions.map(row => row.shipmentId), ['SHIP1']);
    assert.deepEqual(created, ['1']);
    assert.equal(uploads.length, 0);
    second.mes.items[0].quantity = 12;
    const secondResult = await submitAsns({ ...request, retryShipmentId: 'SHIP2' }, options);
    assert.deepEqual(secondResult.transactions.map(row => row.shipmentId), ['SHIP2']);
    assert.deepEqual(created, ['1', '2']);
    assert.equal(uploads.length, 0);
    assert.equal(secondResult.transactions.length, 1);
    await assert.rejects(submitAsns({ ...request, retryShipmentId: 'OTHER' }, options), /uniquely/);
});
