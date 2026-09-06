const test = require("node:test");
const assert = require("node:assert/strict");
const {
    allocationsMatch,
    buildOutboundDocument,
    getCartonCount,
    hasPhysicalProgress,
    normalizeOutboundItems,
    prepareOutboundUpdate,
    prepareShipmentDocuments,
    validateOutboundItems,
} = require("./outboundOrder");

const items = [
    { item_bar_code: "111", total_item_qty: 6, external_id: "062-05-4428", vcp_qty: 6, item_description: "King" },
    { item_bar_code: "222", total_item_qty: 12, external_id: "062-05-5107", vcp_qty: 6, item_description: "Standard" },
];

test("normalizes ERP items and removes zero-quantity lines", () => {
    const normalized = normalizeOutboundItems([
        ...items,
        { total_item_qty: 0, external_id: "062-05-7289", vcp_qty: 6 },
    ]);

    assert.deepEqual(normalized.map(item => item.styleCode), ["062054428", "062055107"]);
    assert.equal(getCartonCount(normalized), 3);
});

test("rejects an empty or partial-carton shipment", () => {
    assert.throws(() => validateOutboundItems([], "PO-1"), /no local shippable items/);
    assert.throws(
        () => validateOutboundItems([{ styleCode: "1", quantity: 7, casePack: 6 }], "PO-1"),
        /not a whole carton/
    );
});

test("compares physical allocations without depending on item order or description", () => {
    const left = normalizeOutboundItems(items);
    const right = [...left].reverse().map(item => ({ ...item, description: "Updated description" }));
    assert.equal(allocationsMatch(left, right), true);
    assert.equal(allocationsMatch(left, [{ ...left[0], quantity: 12 }, left[1]]), false);
});

test("builds outbound documents from the stored header and authoritative items", () => {
    const document = buildOutboundDocument(
        { poNumber: "100", poDate: "2026-01-01", client: "Target" },
        { poNumber: "100-0580", name: "Madison", items },
        items
    );

    assert.equal(document.masterPO, "100");
    assert.equal(document.poNumber, "100-0580");
    assert.equal(document.items.length, 2);
    assert.equal(getCartonCount(document.items), 3);
});

test("detects work that makes a load allocation immutable", () => {
    assert.equal(hasPhysicalProgress({ status: "Carrier Accepted, Awaiting Pickup", checklist: {} }), false);
    assert.equal(hasPhysicalProgress({ status: "Picked Up" }), true);
    assert.equal(hasPhysicalProgress({ checklist: { printed: { status: true } } }), true);
    assert.equal(hasPhysicalProgress({ bol: { number: "BOL-1" } }), true);
});

test("repairs an unstarted single load when its cartons match the ERP quantity", () => {
    const buyer = { poNumber: "100-0580", items };
    const outbound = {
        poNumber: buyer.poNumber,
        items: [],
        loads: [{ loadNumber: "777", cartons: 3, status: "Carrier Accepted, Awaiting Pickup", checklist: {} }],
    };
    const update = prepareOutboundUpdate({ poNumber: "100", client: "Target" }, buyer, outbound);

    assert.equal(update.items.length, 2);
    assert.equal(update.loads[0].items.length, 2);
    assert.equal(getCartonCount(update.loads[0].items), 3);
    assert.equal(update.loads[0].status, outbound.loads[0].status);
});

test("blocks a PO quantity change until the ERP load carton count agrees", () => {
    const buyer = { poNumber: "100-0580", items };
    const outbound = {
        poNumber: buyer.poNumber,
        items: [{ upc: "111", quantity: 6, casePack: 6, styleCode: "062054428" }],
        loads: [{ loadNumber: "777", cartons: 4, status: "Carrier Accepted, Awaiting Pickup", checklist: {} }],
    };

    assert.throws(
        () => prepareOutboundUpdate({ poNumber: "100" }, buyer, outbound),
        /changed to 3 cartons.*has 4/
    );
});

test("blocks a PO quantity change after physical shipping work starts", () => {
    const buyer = { poNumber: "100-0580", items };
    const outbound = {
        poNumber: buyer.poNumber,
        items: [],
        loads: [{ loadNumber: "777", cartons: 3, checklist: { printed: { status: true } } }],
    };

    assert.throws(
        () => prepareOutboundUpdate({ poNumber: "100" }, buyer, outbound),
        /after shipping work started/
    );
});

test("prepares new shipment documents from the complete local MES order", () => {
    const storedItems = normalizeOutboundItems(items);
    const order = {
        poNumber: "100",
        client: "Target",
        buyers: [{ poNumber: "100-0580", name: "Madison", items: storedItems }],
    };
    const documents = prepareShipmentDocuments(order);

    assert.equal(documents.length, 1);
    assert.equal(documents[0].poNumber, "100-0580");
    assert.deepEqual(documents[0].items, storedItems);
});

test("blocks shipment creation when local MES data is incomplete", () => {
    assert.throws(
        () => prepareShipmentDocuments({ poNumber: "100", buyers: [] }),
        /no local destinations/
    );
    assert.throws(
        () => prepareShipmentDocuments({
            poNumber: "100",
            buyers: [{ poNumber: "100-0580", items: [] }],
        }),
        /no local shippable items/
    );
});
