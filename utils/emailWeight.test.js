const test = require("node:test");
const assert = require("node:assert/strict");
const { weighEmail, isClosingSection } = require("./emailWeight");
const { buildSignatureSuffixBySender } = require("./emailSignature");

const candidates = [{ loadNumber: "75736164", proNumber: "202998812", scac: "ARKA" }];
const from = "Jeff Miller <jeff@arkafreight.com>";

test("fresh request keeps content at full weight and anchors on the closing", () => {
    const body = "Can we get a pickup time for load 75736164 this Friday?\n\nThanks,\nJeff Miller\nARKA Freight\n(555) 123-4567";
    const { sections, relevantText, anchorIndex } = weighEmail(body, { from, candidates });

    assert.equal(sections[0].type, "content");
    assert.equal(sections[0].weight, 1);
    assert.equal(sections[0].kept, true);
    assert.equal(sections[anchorIndex].type, "closing");
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

test("learned closing suffix anchors the sender block", () => {
    const sig = "Jeff Miller\nARKA Freight Dispatch";
    const suffixBySender = buildSignatureSuffixBySender([
        { from, body: `First message\n\n${sig}` },
        { from, body: `Second message\n\n${sig}` },
    ]);

    const { sections, anchorIndex } = weighEmail(`Need a pickup slot.\n\n${sig}`, { from, candidates, suffixBySender });

    assert.equal(sections[anchorIndex].type, "closing");
    assert.ok(sections[anchorIndex].text.includes("Jeff Miller"));
    assert.equal(sections[anchorIndex].weight, 0.25);
});

test("all-fresh email keeps everything with mild top-down decay", () => {
    const { sections, anchorIndex } = weighEmail("First paragraph.\n\nSecond paragraph.", { from, candidates });

    assert.equal(anchorIndex, -1);
    assert.equal(sections[0].weight, 1);
    assert.equal(sections[1].weight, 0.85);
    assert.ok(sections.every(section => section.kept));
});

test("name block after the sign-off becomes one closing section", () => {
    const body = "Pickup confirmed for load 75736164 at 2pm.\n\nThank you\nBest Regards,\n\nJeff Miller\nOperations Manager\nARKA Freight";
    const { sections, anchorIndex } = weighEmail(body, { from, candidates });

    assert.equal(sections[0].type, "content");
    assert.equal(sections[anchorIndex].type, "closing");
    assert.equal(sections[anchorIndex].closingLines.find(line => line.role === "name")?.text, "Jeff Miller");
    assert.equal(sections[anchorIndex].closingLines.find(line => line.role === "title")?.text, "Operations Manager");
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

test("carrier vocabulary below the closing is treated as quoted history", () => {
    const body = "Works for us.\n\nThanks,\nJeff\n\nDriver will check in at dock 12.";
    const { sections } = weighEmail(body, { from, candidates });

    assert.equal(sections[1].type, "closing");
    assert.equal(sections[2].type, "quote");
    assert.equal(sections[2].kept, false);
});

test("long unspaced strings are dampened as non-prose", () => {
    const body = "Please review the shipment details below.\n\nhttps://tms.example.com/track/abcdef1234567890?token=zyxwvut9876543210";
    const { sections } = weighEmail(body, { from, candidates });

    assert.equal(sections[1].weight, 0.26);
    assert.equal(sections[1].kept, false);
});

test("normalized reference match catches carrier formatting", () => {
    const body = "PRO #202-998-812 is scheduled for pickup at 2pm tomorrow.";
    const { relevantText } = weighEmail(body, { from, candidates: [{ proNumber: "202998812" }] });

    assert.ok(relevantText.includes("202-998-812"));
});

test("html br boundaries segment flattened gmail bodies", () => {
    const body = "Pickup confirmed for load 75736164 at 2pm.<br><br>Thanks,<br>Jeff Miller";
    const { sections, relevantText } = weighEmail(body, { from, candidates });

    assert.equal(sections[0].type, "content");
    assert.ok(relevantText.includes("75736164"));
    assert.ok(sections.some(isClosingSection));
});

test("without candidates stops once schedule and intent are found", () => {
    const body = "Driver will arrive at dock 12 around 2pm tomorrow.\n\nAlso please send updated billing info.";
    const { sections, relevantText } = weighEmail(body, { from, candidates: [] });

    assert.equal(sections[0].kept, true);
    assert.equal(sections[1].kept, false);
    assert.ok(relevantText.includes("dock 12"));
    assert.ok(!relevantText.includes("billing"));
});

test("single newline before closing still splits name block", () => {
    const body = "Confirmed for tomorrow.\nJane Doe\nShipping Coordinator";
    const { sections } = weighEmail(body, { from, candidates });

    assert.equal(sections[0].type, "content");
    assert.equal(sections[1].type, "closing");
    assert.ok(sections[1].closingLines.some(line => line.role === "name" && line.text.includes("Jane Doe")));
});

test("simple outgoing note keeps only the lead sentence", () => {
    const body = "Sounds good. We will see you then.\n\nThanks,\nShipping Team";
    const { sections, relevantText } = weighEmail(body, { from: "Shipping <ship@ourco.com>", candidates, outgoing: true });

    assert.equal(relevantText, "Sounds good.");
    assert.equal(sections[0].kept, true);
    assert.ok(sections.some(isClosingSection));
});

test("outgoing with a question uses top-heavy weighting", () => {
    const body = "Can you confirm pickup for load 75736164 tomorrow?\n\nThanks,\nShipping";
    const { relevantText } = weighEmail(body, { from: "Shipping <ship@ourco.com>", candidates, outgoing: true });

    assert.ok(relevantText.includes("75736164"));
});

test("truncated gmail quote header is marked quote", () => {
    const body = "Sounds good.\n\nThanks,\nShipping Team\nOn Mon, Jul 6, 2026 at 8:38 AM Nicholas Singley <";
    const { sections } = weighEmail(body, { from: "Shipping <ship@ourco.com>", candidates, outgoing: true });

    assert.ok(sections.some(section => section.type === "quote" && section.text.includes("On Mon, Jul 6")));
    assert.equal(sections.find(section => section.text.includes("On Mon, Jul 6"))?.kept, false);
});

test("reply history after closing is all quote", () => {
    const body = "Please advise.\n\nThanks,\nTeam\nOn Mon, Jul 6, 2026 at 1:09 PM Swift Transportation <\n> earlier message";
    const { sections, relevantText } = weighEmail(body, { from, candidates });

    const quoteSections = sections.filter(section => section.type === "quote");
    assert.ok(quoteSections.length >= 1);
    assert.ok(relevantText.includes("Please advise"));
    assert.ok(!relevantText.includes("Swift Transportation"));
});

test("closing block splits into sign-off, name, title, and company", () => {
    const body = "Pickup confirmed.\n\nThanks,\nJeff Miller\nOperations Manager\nARKA Freight\n(555) 123-4567";
    const { sections } = weighEmail(body, { from, candidates });
    const closing = sections.find(isClosingSection);

    assert.equal(closing.closingLines.find(line => line.role === "signoff")?.text, "Thanks,");
    assert.equal(closing.closingLines.find(line => line.role === "name")?.text, "Jeff Miller");
    assert.equal(closing.closingLines.find(line => line.role === "title")?.text, "Operations Manager");
    assert.equal(closing.closingLines.find(line => line.role === "company")?.text, "ARKA Freight");
    assert.ok(closing.closingLines.find(line => line.role === "contact")?.text.includes("555"));
});

test("name title address block without sign-off is detected as closing", () => {
    const body = "Confirmed\nKylee Rusch\n|\nCustomer Service Assistant\nP.O.Box 750\n1916 E. 29th St. Marshfield, WI 54449";
    const { sections, relevantText } = weighEmail(body, { from: "Kylee Rusch <kylee@example.com>", candidates: [] });
    const closing = sections.find(isClosingSection);

    assert.equal(sections[0].type, "content");
    assert.equal(sections[0].text, "Confirmed");
    assert.ok(closing);
    assert.equal(closing.closingLines.find(line => line.role === "name")?.text, "Kylee Rusch");
    assert.equal(closing.closingLines.find(line => line.role === "title")?.text, "Customer Service Assistant");
    assert.ok(closing.closingLines.some(line => line.role === "address" && line.text.includes("P.O.Box")));
    assert.equal(relevantText, "Confirmed");
});

test("second name-shaped or title line becomes company, not a duplicate role", () => {
    const body = "Thanks,\nJeff Miller\nOperations Manager\nCustomer Service Assistant\nARKA Freight";
    const { sections } = weighEmail(body, { from, candidates });
    const closing = sections.find(isClosingSection);

    assert.equal(closing.closingLines.filter(line => line.role === "name").length, 1);
    assert.equal(closing.closingLines.filter(line => line.role === "title").length, 1);
    assert.equal(closing.closingLines.find(line => line.role === "title")?.text, "Operations Manager");
    assert.equal(closing.closingLines.find(line => line.role === "company" && line.text === "Customer Service Assistant")?.text, "Customer Service Assistant");
    assert.equal(closing.closingLines.find(line => line.role === "company" && line.text === "ARKA Freight")?.text, "ARKA Freight");
});

test("two name lines without title or address is not treated as closing", () => {
    const body = "Please confirm pickup.\nJohn Smith\nJane Doe";
    const { sections } = weighEmail(body, { from, candidates });

    assert.ok(!sections.some(isClosingSection));
    assert.equal(sections[0].type, "content");
});

test("cid refs and http lines in closing get gibberish and link roles", () => {
    const body = "Thanks,\nJeff Miller\nARKA Freight\n[cid:f7a6d549-fdc2-4669-b20a-f233f68450b1]\nhttps://cdn.example.com/logo.png";
    const { sections } = weighEmail(body, { from, candidates });
    const closing = sections.find(isClosingSection);

    assert.equal(closing.closingLines.find(line => line.text.includes("cid:"))?.role, "gibberish");
    assert.equal(closing.closingLines.find(line => line.text.startsWith("https://"))?.role, "link");
    assert.equal(closing.closingLines.find(line => line.role === "company")?.text, "ARKA Freight");
});

test("sender-anchored hyphenated name-title line splits into name and title", () => {
    const body = "Pickup confirmed.\n\nThanks,\nAmy Foster-Logistics Planner";
    const { sections } = weighEmail(body, { from: "Amy Foster <amy@example.com>", candidates: [] });
    const closing = sections.find(isClosingSection);

    assert.equal(sections[0].type, "content");
    assert.equal(closing.closingLines.find(line => line.role === "signoff")?.text, "Thanks,");
    assert.equal(closing.closingLines.find(line => line.role === "name")?.text, "Amy Foster");
    assert.equal(closing.closingLines.find(line => line.role === "title")?.text, "Logistics Planner");
});

test("sign-off only message stays content, not a closing block", () => {
    const { sections, relevantText } = weighEmail("Thank you,", { from, candidates });

    assert.equal(sections.length, 1);
    assert.equal(sections[0].type, "content");
    assert.equal(sections[0].text, "Thank you,");
    assert.ok(!sections.some(isClosingSection));
    assert.equal(relevantText, "Thank you,");
});

test("full roehl signature block classifies contact phone email and link", () => {
    const body = [
        "Thank you",
        "Kylee Rusch",
        "Customer Service Assistant",
        "P.O.Box 750",
        "1916 E. 29th St. Marshfield, WI 54449",
        "O: 715‑591‑7000 Ext.2942<tel:2942>",
        "Kylee.Rusch@roehl.net<mailto:Kylee.Rusch@roehl.net>",
        "RoehlTransport.com<https://roehltransport.com/>",
    ].join("\n");
    const { sections, relevantText } = weighEmail(body, { from: "Kylee Rusch <Kylee.Rusch@roehl.net>", candidates: [] });
    const closing = sections.find(isClosingSection);

    assert.ok(closing);
    assert.equal(closing.closingLines.find(line => line.role === "name")?.text, "Kylee Rusch");
    assert.equal(closing.closingLines.find(line => line.role === "title")?.text, "Customer Service Assistant");
    assert.ok(closing.closingLines.some(line => line.role === "address" && line.text.includes("P.O.Box")));
    assert.ok(closing.closingLines.some(line => line.role === "contact" && line.text.includes("715")));
    assert.ok(closing.closingLines.some(line => line.role === "contact" && line.text.includes("@roehl.net")));
    assert.ok(closing.closingLines.some(line => line.role === "link" && line.text.includes("roehltransport.com")));
    assert.equal(relevantText, "Thank you");
});

test("roehl signature after content keeps only the message as relevant text", () => {
    const body = `Confirmed\n\nThank you\nKylee Rusch\nCustomer Service Assistant\nP.O.Box 750\n1916 E. 29th St. Marshfield, WI 54449\nO: 715‑591‑7000 Ext.2942<tel:2942>`;
    const { sections, relevantText } = weighEmail(body, { from: "Kylee Rusch <Kylee.Rusch@roehl.net>", candidates: [] });

    assert.equal(sections[0].type, "content");
    assert.equal(sections[0].text, "Confirmed");
    assert.ok(sections.some(isClosingSection));
    assert.equal(relevantText, "Confirmed");
});

test("thank you reply with auto signature shows only thank you as content", () => {
    const body = [
        "Thank you",
        "Kylee Rusch",
        "Customer Service Assistant",
        "P.O.Box 750",
        "1916 E. 29th St. Marshfield, WI 54449",
    ].join("\n");
    const { sections } = weighEmail(body, { from: "Kylee Rusch <Kylee.Rusch@roehl.net>", candidates: [] });

    assert.equal(sections[0].type, "content");
    assert.equal(sections[0].text, "Thank you");
    assert.equal(sections[1].type, "closing");
    assert.ok(!sections[1].closingLines.some(line => line.role === "signoff"));
    assert.equal(sections[1].closingLines.find(line => line.role === "name")?.text, "Kylee Rusch");
});
