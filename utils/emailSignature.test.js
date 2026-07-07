const test = require("node:test");
const assert = require("node:assert/strict");
const { buildSignatureSuffixBySender, splitMessageBody } = require("./emailSignature");

const sig = "Thanks,\nJeff Miller\nARKA Freight\n(555) 123-4567";

test("buildSignatureSuffixBySender finds a repeated tail from the same sender", () => {
    const suffixBySender = buildSignatureSuffixBySender([
        { from: "Jeff <jeff@arka.com>", body: `Can we get an appt?\n\n${sig}` },
        { from: "Jeff <jeff@arka.com>", body: `2pm works\n\n${sig}` },
    ]);

    assert.deepEqual(suffixBySender["jeff@arka.com"], sig.split("\n"));
});

test("splitMessageBody removes the detected signature and keeps message text", () => {
    const suffixBySender = buildSignatureSuffixBySender([
        { from: "Jeff <jeff@arka.com>", body: `Can we get an appt?\n\n${sig}` },
        { from: "Jeff <jeff@arka.com>", body: `2pm works\n\n${sig}` },
    ]);

    assert.deepEqual(
        splitMessageBody(`2pm works\n\n${sig}`, suffixBySender, "Jeff <jeff@arka.com>"),
        { text: "2pm works", signature: sig }
    );
});

test("splitMessageBody falls back to the RFC-style delimiter on single messages", () => {
    const body = "Confirmed for 1400.\n\n-- \nJeff Miller\nARKA Freight";

    assert.deepEqual(
        splitMessageBody(body, {}, "Jeff <jeff@arka.com>"),
        { text: "Confirmed for 1400.", signature: "Jeff Miller\nARKA Freight" }
    );
});
