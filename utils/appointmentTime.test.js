const test = require("node:test");
const assert = require("node:assert/strict");
const { parseMilitaryTime, formatMilitaryTime } = require("./appointmentTime");

test("parseMilitaryTime accepts 4-digit military time", () => {
    assert.equal(parseMilitaryTime("1300"), "1300");
    assert.equal(parseMilitaryTime("0900"), "0900");
});

test("parseMilitaryTime converts 12-hour text to military time", () => {
    assert.equal(parseMilitaryTime("1pm"), "1300");
    assert.equal(parseMilitaryTime("1 pm"), "1300");
    assert.equal(parseMilitaryTime("2pm"), "1400");
    assert.equal(parseMilitaryTime("12pm"), "1200");
    assert.equal(parseMilitaryTime("12am"), "0000");
    assert.equal(parseMilitaryTime("1:30pm"), "1330");
    assert.equal(parseMilitaryTime("13:00"), "1300");
});

test("formatMilitaryTime converts military time to readable text", () => {
    assert.equal(formatMilitaryTime("1300"), "1pm");
    assert.equal(formatMilitaryTime("1400"), "2pm");
    assert.equal(formatMilitaryTime("0900"), "9am");
    assert.equal(formatMilitaryTime("1330"), "1:30pm");
});

test("formatMilitaryTime round-trips common carrier replies", () => {
    assert.equal(formatMilitaryTime(parseMilitaryTime("1pm")), "1pm");
    assert.equal(parseMilitaryTime(formatMilitaryTime("1300")), "1300");
});

test("formatMilitaryTime supports compact slot labels", () => {
    assert.equal(formatMilitaryTime("1300", { compact: true }), "1p");
    assert.equal(formatMilitaryTime("0900", { compact: true }), "9a");
    assert.equal(formatMilitaryTime("1330", { compact: true }), "1:30p");
});
