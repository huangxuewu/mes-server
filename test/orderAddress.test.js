const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const outboundOrder = require('../utils/outboundOrder');

const buyer = {
    poNumber: '100-0551', name: 'Target DC 0551', address: '7120 HWY 65 NE',
    city: 'FRIDLEY', state: 'MN', zip: '55432', country: 'US', done: false,
    items: [{ styleCode: '062054428', quantity: 12, casePack: 6 }],
};

const fixture = () => {
    const calls = [];
    const order = { _id: 'order-1', poNumber: '100', orderStatus: 'Fulfilled', buyers: [buyer] };
    const loads = [{ loadNumber: 'LOAD-1', status: 'Picked Up', items: buyer.items,
        bol: { number: 'BOL-1' } }];
    const db = {
        order: {
            findById: () => ({ lean: async () => order }),
            findByIdAndUpdate: async (id, update) => {
                calls.push({ action: 'order', update });
                return { ...order, ...update.$set };
            },
        },
        outbound: {
            find: () => ({ lean: async () => [{ _id: 'outbound-1', ...buyer, loads }] }),
            bulkWrite: async operations => { calls.push({ action: 'outbound', operations }); },
            create: async documents => { calls.push({ action: 'create', documents }); },
            deleteMany: async query => { calls.push({ action: 'delete', query }); },
        },
    };
    const handlers = {};
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../socket/event/order.js'), 'utf8'), {
        module,
        require: name => name === '../../models' ? db : outboundOrder,
    });
    module.exports({ on: (name, handler) => { handlers[name] = handler; } }, {});
    const update = async (buyers, event = 'order:po-update') => {
        let result;
        await handlers[event]({ _id: order._id, buyers, items: { '062054428': buyer.items[0] } },
            response => { result = response; });
        return result;
    };
    return { update, calls, loads };
};

test('partial DC payloads from older clients and CSV imports cannot overwrite orders or shipments', async () => {
    for (const field of ['address', 'city', 'state', 'zip', 'country']) {
        for (const value of [undefined, null, '', '   ']) {
            const f = fixture();
            const response = await f.update([buyer, { ...buyer, poNumber: '100-0553', [field]: value }]);
            assert.equal(response.status, 'error');
            assert.match(response.message, new RegExp(`100-0553.*${field}`));
            assert.equal(f.calls.length, 0);
        }
    }
});

test('status updates from sparse cached buyers retain saved addresses and items', async () => {
    for (const incoming of [{ poNumber: buyer.poNumber, done: true },
        { poNumber: buyer.poNumber, done: true, items: buyer.items }]) {
        const f = fixture();
        const response = await f.update([incoming], 'order:update');
        assert.equal(response.status, 'success');
        const saved = response.payload.buyers[0];
        for (const field of ['address', 'city', 'state', 'zip', 'country'])
            assert.equal(saved[field], buyer[field]);
        assert.equal(saved.done, true);
        assert.equal(saved.items[0].quantity, 12);
    }
});

test('complete address changes update order and outbound headers without replacing physical loads', async () => {
    const f = fixture();
    const response = await f.update([{ ...buyer, address: 'Updated street' }]);
    assert.equal(response.status, 'success');
    assert.equal(response.payload.orderStatus, 'Fulfilled');
    assert.equal(response.payload.buyers[0].address, 'Updated street');
    assert.deepEqual(f.calls.map(call => call.action), ['order', 'outbound']);
    const header = f.calls[1].operations[0].updateOne.update.$set;
    assert.equal(header.address, 'Updated street');
    assert.equal(header.items[0].quantity, 12);
    assert.ok(!Object.hasOwn(header, 'loads'));
    assert.equal(f.loads[0].bol.number, 'BOL-1');
});
