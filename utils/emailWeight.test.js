const test = require("node:test");
const assert = require("node:assert/strict");
const { weighEmail } = require("./emailWeight");
const { buildSignatureSuffixBySender } = require("./emailSignature");

const candidates = [{ loadNumber: "75736164", proNumber: "202998812", scac: "ARKA" }];
const from = "Jeff Miller <jeff@arkafreight.com>";

test("fresh request keeps content at full weight and anchors on the sign-off", () => {
    const body = "Can we get a pickup time for load 75736164 this Friday?\n\nThanks,\nJeff Miller\nARKA Freight\n(555) 123-4567";
    const { sections, relevantText, anchorIndex } = weighEmail(body, { from, candidates });

    assert.equal(sections[0].type, "content");
    assert.equal(sections[0].weight, 1);
    assert.equal(sections[0].kept, true);
    assert.equal(sections[anchorIndex].type, "signature");
    assert.ok(relevantText.includes("75736164"));
});

test("quoted reply history is capped low and dropped", () => {
    const body = "Works for us.\n\nOn Mon, Jun 1, 2026 at 9:00 AM Shipping <ship@ourco.com> wrote:\n> Can you pick up tomorrow?\n> Let us know.";
    const { sections, anchorIndex, relevantText } = weighEmail(body, { from, candidates });

    const quotes = sections.filter(section => section.type === "quote");
    assert.ok(quotes.length >= 1);
    quotes.forEach((section) => {
        assert.ok(section.weight <= 0.2);
        assert.equal(section.kept, false);
    });
    assert.equal(anchorIndex, 1);
    assert.equal(relevantText, "Works for us.");
});

test("confidentiality disclaimer gets zero weight", () => {
    const body = "Driver will arrive around 2pm.\n\nThis email and any attachments are confidential and intended solely for the named recipient. If you have received this email in error please notify the sender.";
    const { sections } = weighEmail(body, { from, candidates });

    assert.equal(sections[1].type, "disclaimer");
    assert.equal(sections[1].weight, 0);
    assert.equal(sections[1].kept, false);
    assert.equal(sections[0].kept, true);
});

test("a sentence starting with From: is kept, not cut", () => {
    const body = "Sorry for the slow reply.\nFrom: our side there is no issue with load 75736164.";
    const { sections, relevantText } = weighEmail(body, { from, candidates });

    assert.equal(sections.length, 1);
    assert.equal(sections[0].type, "content");
    assert.ok(relevantText.includes("no issue with load 75736164"));
});

test("a real forwarded header block becomes quote, including what follows", () => {
    const body = "Please see below.\n\nFrom: Jeff Miller <jeff@arkafreight.com>\nSent: Monday, June 1, 2026 9:00 AM\nTo: shipping@ourco.com\nSubject: Load 75736164\n\nCan we do 2pm?";
    const { sections } = weighEmail(body, { from, candidates });

    assert.equal(sections[0].type, "content");
    assert.equal(sections[0].kept, true);
    assert.equal(sections[1].type, "quote");
    assert.equal(sections[2].type, "quote");
    assert.equal(sections[2].kept, false);
});

test("stops keeping sections once reference and time are found", () => {
    const body = "Load 75736164 is confirmed for 2pm tomorrow.\n\nSeparately, do you have any loads to Dallas next week?\n\nOur billing team will send the detention invoice.";
    const { sections, relevantText } = weighEmail(body, { from, candidates });

    assert.equal(sections[0].kept, true);
    assert.equal(sections[1].kept, false);
    assert.equal(sections[1].weight, 0);
    assert.equal(sections[2].kept, false);
    assert.ok(!relevantText.includes("Dallas"));
});

test("learned signature suffix anchors the sender block", () => {
    const sig = "Jeff Miller\nARKA Freight Dispatch";
    const suffixBySender = buildSignatureSuffixBySender([
        { from, body: `First message\n\n${sig}` },
        { from, body: `Second message\n\n${sig}` },
    ]);

    const { sections, anchorIndex } = weighEmail(`Need a pickup slot.\n\n${sig}`, { from, candidates, suffixBySender });

    assert.equal(sections[anchorIndex].type, "signature");
    assert.equal(sections[anchorIndex].text, sig);
    assert.equal(sections[anchorIndex].weight, 0.35);
});

test("all-fresh email keeps everything with mild top-down decay", () => {
    const { sections, anchorIndex } = weighEmail("First paragraph.\n\nSecond paragraph.", { from, candidates });

    assert.equal(anchorIndex, -1);
    assert.equal(sections[0].weight, 1);
    assert.equal(sections[1].weight, 0.85);
    assert.ok(sections.every(section => section.kept));
});

test("name block after the sign-off is signature, not content", () => {
    const body = "Pickup confirmed for load 75736164 at 2pm.\n\nThank you\nBest Regards,\n\nJeff Miller\nOperations Manager\nARKA Freight";
    const { sections, anchorIndex } = weighEmail(body, { from, candidates });

    assert.equal(sections[0].type, "content");
    assert.ok(sections.slice(1).every(section => section.type === "signature"));
    assert.equal(anchorIndex, 1);
});

test("sender-less machine email anchors on the load reference", () => {
    const body = "This is an automated notification from the TMS system.\n\nLoad 75736164 pickup window 06/08 13:00.\n\nDo not reply to this message.";
    const { sections, anchorIndex } = weighEmail(body, { from: "noreply@tms.example.com", candidates });

    assert.equal(anchorIndex, 1);
    assert.equal(sections[1].weight, 1);
    assert.equal(sections[1].kept, true);
    assert.equal(sections[0].weight, 0.7);
    assert.equal(sections[2].kept, false);
});

test("carrier vocabulary boosts a section below the anchor", () => {
    const body = "Works for us.\n\nThanks,\nJeff\n\nDriver will check in at dock 12.";
    const { sections } = weighEmail(body, { from, candidates });

    assert.equal(sections[1].type, "signature");
    assert.equal(sections[2].type, "content");
    assert.equal(sections[2].weight, 0.45);
    assert.equal(sections[2].kept, true);
});

test("long unspaced strings are dampened as non-prose", () => {
    const body = "Please review the shipment details below.\n\nhttps://tms.example.com/track/abcdef1234567890?token=zyxwvut9876543210";
    const { sections } = weighEmail(body, { from, candidates });

    assert.equal(sections[1].weight, 0.26);
    assert.equal(sections[1].kept, false);
});
