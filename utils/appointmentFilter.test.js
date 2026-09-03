const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveThreadLoad, resolveThreadLoads, hydrateThread } = require("./appointmentFilter");

const candidates = [
    { loadNumber: "77750565", proNumber: "6833568694", scac: "AFXN" },
    { loadNumber: "88880000", proNumber: "1234567890", scac: "TEST" },
    { loadNumber: "99990000", proNumber: "5555555555", scac: "TEST" },
];

test("resolveThreadLoad prioritizes an active load number in the subject", () => {
    const result = resolveThreadLoad({
        subject: "AFXN Pickup Request - 77750565",
        messages: [{ body: "Previous reference 88880000" }],
    }, candidates);

    assert.deepEqual(result, {
        loadNumber: "77750565",
        proNumber: "6833568694",
        scac: "AFXN",
    });
});

test("resolveThreadLoad accepts an active load number in the message content", () => {
    const result = resolveThreadLoad({
        subject: "Pickup appointment request",
        messages: [{ body: "Please schedule active load 77750565." }],
    }, candidates);

    assert.equal(result?.loadNumber, "77750565");
});

test("resolveThreadLoad rejects mail without an active load reference", () => {
    const result = resolveThreadLoad({
        subject: "Freight rate promotion",
        messages: [{ body: "Save on your next shipment." }],
    }, candidates);

    assert.equal(result, null);
});

test("resolveThreadLoads returns every active load mentioned in one email", () => {
    const result = resolveThreadLoads({
        subject: "Pickup appointment request 77750565",
        messages: [{ body: "Please also schedule 88880000." }],
    }, candidates);

    assert.deepEqual(result.map(item => item.loadNumber), ["77750565", "88880000"]);
});

test("hydrateThread creates independent associations for every mentioned load", () => {
    const proposedTime = new Date("2026-09-08T17:00:00.000Z");
    const result = hydrateThread({
        loadNumber: "77750565",
        proNumber: "6833568694",
        scac: "AFXN",
        status: "Time Proposed",
        proposedTime,
        subject: "Pickup appointment request",
        messages: [{ body: "77750565\n88880000\n99990000" }],
    }, candidates);

    assert.deepEqual(result.loadAssociations, [
        { loadNumber: "77750565", proNumber: "6833568694", scac: "AFXN", status: "Time Proposed", proposedTime },
        { loadNumber: "88880000", proNumber: "1234567890", scac: "TEST", status: "New", proposedTime: null },
        { loadNumber: "99990000", proNumber: "5555555555", scac: "TEST", status: "New", proposedTime: null },
    ]);
});
