const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const mongoose = require('mongoose');
const { EventEmitter } = require('node:events');

test('outbound schema retains follow-up flags and defaults them to incomplete', () => {
    let schema;
    const dependencies = {
        mongoose, '../socket/io': { io: {} }, '../utils/outboundScac': {},
        '../config/database': { model: (_name, definition) => { schema = definition; return { watch: () => new EventEmitter(), createIndexes() {}, hooks: { pre() {} } }; } },
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../models/outbound.js'), 'utf8'), {
        module: { exports: {} }, require: name => dependencies[name],
    });
    const document = new mongoose.Document({ poNumber: 'PO1', loads: [{ shipmentId: 'SHIP1' }] }, schema);
    assert.equal(document.loads[0].checklist.noticed.status, false);
    assert.equal(document.loads[0].checklist.invoiced.status, false);
    document.loads[0].checklist.invoiced = { status: true, timestamp: new Date() };
    assert.equal(document.toObject().loads[0].checklist.invoiced.status, true);
});

const fixture = (db, submitAsns) => {
    const handlers = {};
    const events = [];
    const dependencies = {
        '../../utils/dayjs': () => {}, '../../models': db, mongoose,
        'node:perf_hooks': { performance: {} }, '../../utils/outboundScac': { requiresBol: () => true },
        '../../utils/outboundOrder': {}, '../../utils/edi/asn': { submitAsns },
    };
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../socket/event/shipment.js'), 'utf8'), {
        module, Date, console, require: name => dependencies[name],
    });
    module.exports({ on: (name, handler) => { handlers[name] = handler; }, emit: (name, payload) => events.push({ name, payload }) }, {});
    return { handlers, events };
};

test('ASN receipt records Noticed before reporting success, including partial submissions', async () => {
    const writes = [];
    const db = { outbound: {
        find: () => ({ lean: async () => [{ poNumber: 'PO1', loads: [{ shipmentId: 'SHIP1', loadNumber: '1234' }] }] }),
        updateOne: async (...args) => { writes.push(args); },
    } };
    const { handlers, events } = fixture(db, async (_request, { onProgress }) => {
        await onProgress({ phase: 'received', shipmentId: 'SHIP1' });
        assert.equal(writes.length, 1);
        throw new Error('Later submission failed');
    });
    let result;
    await handlers['bill-of-lading:submit-asn']({ loadNumber: '1234', shipmentIdArray: ['SHIP1'] }, response => { result = response; });
    assert.equal(result.status, 'error');
    const update = writes[0][1].$set;
    assert.deepEqual(Object.keys(update), ['loads.$[target].checklist.noticed']);
    assert.equal(update['loads.$[target].checklist.noticed'].status, true);
    assert.ok(update['loads.$[target].checklist.noticed'].timestamp instanceof Date);
    assert.equal(writes[0][2].arrayFilters[0]['target.shipmentId'], 'SHIP1');
    assert.equal(events[0].payload.phase, 'received');
});

test('failed ASN submission never marks Noticed', async () => {
    let writes = 0;
    const { handlers } = fixture({ outbound: {
        find: () => ({ lean: async () => [{ loads: [{ shipmentId: 'SHIP1', loadNumber: '1234' }] }] }),
        updateOne: async () => { writes++; },
    } }, async () => { throw new Error('ERP rejected ASN'); });
    let result;
    await handlers['bill-of-lading:submit-asn']({ loadNumber: '1234', shipmentIdArray: ['SHIP1'] }, response => { result = response; });
    assert.equal(result.status, 'error');
    assert.equal(writes, 0);
});

test('warehouse saves cannot overwrite hidden follow-up flags from a stale checklist', async () => {
    let update;
    const { handlers } = fixture({ outbound: {
        findOne: () => ({ lean: async () => ({ loads: [{}] }) }),
        findOneAndUpdate: async (_query, payload) => { update = payload.$set; return {}; },
    } });
    let result;
    await handlers['load:update']({ shipmentId: 'SHIP1', checklist: {
        loaded: { status: true }, noticed: { status: false }, invoiced: { status: false },
    } }, response => { result = response; });
    assert.equal(result.status, 'success');
    assert.deepEqual(Object.keys(update), ['loads.$[target].checklist.loaded']);
});
