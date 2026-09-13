const assert = require('node:assert/strict');
const test = require('node:test');
const { loadSyncFixture } = require('./support/loadSyncFixture');

const uri = process.env.DATA_SYNC_TEST_URI;
const integration = { skip: !uri };
const fixture = async t => {
    const f = await loadSyncFixture(uri);
    t.after(() => f.close());
    return f;
};
const item = { styleCode: 'PILLOW', quantity: 60, casePack: 6 };
const shipment = (poNumber, load = {}) => ({ poNumber, items: [item], loads: [{
    shipmentId: `SHIP-${poNumber}`, status: 'Pending', cartons: 10, ...load,
}] });
const payload = (poNumber, load = {}) => ({ poNumber, load: { shipmentId: `SHIP-${poNumber}`, ...load } });

test('load sync uses bounded database operations for many shipments sharing orders', integration, async t => {
    const f = await fixture(t);
    const orders = Array.from({ length: 12 }, (_, order) => ({ poNumber: `ORDER-${order}`, orderStatus: 'Pending',
        buyers: Array.from({ length: 20 }, (_, buyer) => ({ poNumber: `PO-${order}-${buyer}`, done: false,
            name: 'Buyer', address: 'Existing address', items: [item] })) }));
    const numbers = orders.flatMap(order => order.buyers.map(buyer => buyer.poNumber));
    await f.db.order.collection.insertMany(orders);
    await f.db.outbound.collection.insertMany(numbers.map(number => shipment(number)));
    f.commands.length = 0;
    const result = await f.sync(numbers.map(number => payload(number, { status: 'Picked Up' })));
    assert.equal(result.status, 'success');
    const reads = f.commands.filter(command => ['find', 'getMore'].includes(command.name));
    const writes = f.commands.filter(command => ['update', 'findAndModify'].includes(command.name));
    assert.ok(reads.length <= 5, `Expected bounded reads, got ${reads.length}`);
    assert.ok(writes.length <= 3, `Expected batched writes, got ${writes.length}`);
    const saved = await f.db.order.find().lean();
    assert.equal(saved.length, 12);
    assert.ok(saved.every(order => order.orderStatus === 'Completed' && order.fulfilledAt instanceof Date));
    assert.ok(saved.every(order => order.buyers.every(buyer => buyer.done && buyer.address === 'Existing address')));
});

test('unchanged reimports do not rewrite shipments or completed orders', integration, async t => {
    const f = await fixture(t);
    const originalDate = new Date('2026-01-01');
    await f.db.outbound.collection.insertOne({ ...shipment('PO-1', { status: 'Picked Up', items: [item] }), updatedAt: originalDate });
    await f.db.order.collection.insertOne({ poNumber: 'ORDER-1', buyers: [{ poNumber: 'PO-1', done: true }],
        orderStatus: 'Completed', fulfilledAt: originalDate, updatedAt: originalDate });
    f.commands.length = 0;
    assert.equal((await f.sync([payload('PO-1', { status: 'Picked Up' })])).status, 'success');
    assert.equal(f.commands.filter(command => command.name === 'update' && command.command.update === 'outbound').length, 0);
    assert.equal(+(await f.db.outbound.findOne().lean()).updatedAt, +originalDate);
    assert.equal(+(await f.db.order.findOne().lean()).updatedAt, +originalDate);
});

test('imports preserve allocation, completed-load rules and warehouse fields', integration, async t => {
    const f = await fixture(t);
    await f.db.outbound.collection.insertMany([
        shipment('MATCH', { checklist: { picked: { status: true } }, bol: { rawData: { note: 'Preserve' } } }),
        shipment('MISMATCH', { cartons: 9 }),
        shipment('PARCEL', { assignedSCAC: 'DMSP', checklist: { loaded: { status: true } } }),
        shipment('BOL', { bol: { url: 'https://example.test/bol', rawData: { note: 'Preserve' } } }),
    ]);
    const result = await f.sync(['MATCH', 'MISMATCH', 'PARCEL', 'BOL'].map(number => payload(number, { status: 'Picked Up' })));
    assert.equal(result.status, 'success');
    assert.equal(result.payload.allocationIssues.length, 1);
    assert.equal(result.payload.allocationIssues[0].poNumber, 'MISMATCH');
    const saved = Object.fromEntries((await f.db.outbound.find().lean()).map(row => [row.poNumber, row.loads[0]]));
    assert.equal(saved.MATCH.items[0].quantity, 60);
    assert.equal(saved.MATCH.checklist.picked.status, true);
    assert.equal(saved.MATCH.bol.rawData.note, 'Preserve');
    assert.equal(saved.MISMATCH.items, undefined);
    assert.equal(saved.PARCEL.status, 'Completed');
    assert.equal(saved.BOL.status, 'Completed');
    assert.equal(saved.BOL.bol.rawData.note, 'Preserve');
});

test('targeted reads retain historical eligibility and support several loads per PO', integration, async t => {
    const f = await fixture(t);
    await f.db.outbound.collection.insertMany([
        shipment('CURRENT'), shipment('UNRELATED'), shipment('OLD', { status: 'Completed', pickupDate: '2020-01-01' }),
    ]);
    f.commands.length = 0;
    const result = await f.sync([payload('CURRENT', { cartons: 4 }),
        payload('CURRENT', { shipmentId: 'SECOND', cartons: 6, status: 'Pending' }),
        payload('OLD', { loadNumber: 'Ignored' }), payload('MISSING', { status: 'Picked Up' })]);
    assert.equal(result.status, 'success');
    const read = f.commands.find(command => command.name === 'find' && command.command.find === 'outbound');
    assert.deepEqual([...read.command.filter.poNumber.$in].sort(), ['CURRENT', 'MISSING', 'OLD']);
    assert.equal((await f.db.outbound.findOne({ poNumber: 'CURRENT' }).lean()).loads.length, 2);
    assert.equal((await f.db.outbound.findOne({ poNumber: 'OLD' }).lean()).loads[0].loadNumber, undefined);
    assert.equal((await f.db.outbound.findOne({ poNumber: 'UNRELATED' }).lean()).loads[0].status, 'Pending');
});

test('order completion is atomic, repairs stale status and retains existing completion dates', integration, async t => {
    const f = await fixture(t);
    const old = new Date('2026-01-01');
    await f.db.order.collection.insertMany([
        { poNumber: 'PARTIAL', orderStatus: 'Pending', buyers: [{ poNumber: 'A', done: false }, { poNumber: 'B', done: false }] },
        { poNumber: 'REPAIR', orderStatus: 'Pending', fulfilledAt: old, buyers: [{ poNumber: 'C', done: true }] },
        { poNumber: 'UNRELATED', orderStatus: 'Pending', buyers: [{ poNumber: 'D', done: false }] },
    ]);
    await f.db.order.updateShipmentStatus(shipment('A', { status: 'Picked Up' }));
    assert.equal((await f.db.order.findOne({ poNumber: 'PARTIAL' }).lean()).orderStatus, 'Pending');
    await Promise.all(['B', 'C'].map(number => f.db.order.updateShipmentStatus(shipment(number, { status: 'Completed' }))));
    const rows = Object.fromEntries((await f.db.order.find().lean()).map(order => [order.poNumber, order]));
    assert.equal(rows.PARTIAL.orderStatus, 'Completed');
    assert.equal(rows.REPAIR.orderStatus, 'Completed');
    assert.equal(+rows.REPAIR.fulfilledAt, +old);
    assert.equal(rows.UNRELATED.buyers[0].done, false);
    await f.db.order.collection.insertOne({ poNumber: 'RACE', orderStatus: 'Pending',
        buyers: [{ poNumber: 'E', done: false }, { poNumber: 'F', done: false }] });
    await Promise.all(['E', 'F'].map(number => f.db.order.updateShipmentStatus(shipment(number, { status: 'Picked Up' }))));
    const concurrent = await f.db.order.findOne({ poNumber: 'RACE' }).lean();
    assert.equal(concurrent.orderStatus, 'Completed');
    assert.ok(concurrent.buyers.every(buyer => buyer.done));
});

test('database errors are returned and success waits for order completion', integration, async t => {
    const f = await fixture(t);
    await f.db.outbound.collection.insertOne(shipment('FAIL'));
    const update = f.db.order.updateShipmentStatus;
    f.db.order.updateShipmentStatus = async () => { throw new Error('Order database unavailable'); };
    const result = await f.sync([payload('FAIL', { status: 'Picked Up' })]);
    assert.equal(result.status, 'error');
    assert.equal(result.message, 'Order database unavailable');
    f.db.order.updateShipmentStatus = update;
    assert.equal((await f.sync([])).status, 'error');
});

test('targeted lookup indexes are defined and created', integration, async t => {
    const f = await fixture(t);
    for (const [model, key] of [[f.db.outbound, 'poNumber'], [f.db.order, 'buyers.poNumber']]) {
        const indexes = await model.collection.indexes();
        assert.ok(indexes.some(index => index.key[key] === 1), `${key} index missing`);
    }
});
