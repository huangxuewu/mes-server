const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const file = path.join(__dirname, '../socket/event/shipment.js');
const requireShipment = createRequire(file);

function fixture(find) {
    const socket = new EventEmitter();
    const module = { exports: {} };
    const dependencies = {
        '../../utils/dayjs': () => {},
        '../../models': { inbound: { find } },
        '../../utils/edi/asn': {},
    };
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
        module, console, Date,
        require: name => Object.hasOwn(dependencies, name) ? dependencies[name] : requireShipment(name),
    });
    module.exports(socket, {});
    return socket;
}

test('inbound fetch registers once and performs one lean query and acknowledgement', async () => {
    const query = { etaDate: { $gte: '2026-09-01', $lte: '2026-09-30' } };
    const rows = [{ _id: 'shipment', status: 'Pending' }];
    let queries = 0;
    let leanReads = 0;
    const socket = fixture(received => {
        assert.equal(received, query);
        queries++;
        return { lean: async () => { leanReads++; return rows; } };
    });
    for (const event of socket.eventNames()) assert.equal(socket.listenerCount(event), 1, event);
    const responses = [];
    socket.emit('inbound:fetch', query, result => responses.push(result));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(queries, 1);
    assert.equal(leanReads, 1);
    assert.equal(responses.length, 1);
    assert.equal(responses[0].status, 'success');
    assert.equal(responses[0].payload, rows);
});

test('inbound fetch returns one failure acknowledgement and permits an omitted callback', async () => {
    const socket = fixture(() => ({ lean: async () => { throw new Error('Database unavailable'); } }));
    const responses = [];
    socket.emit('inbound:fetch', {}, result => responses.push(result));
    socket.emit('inbound:fetch', {});
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(responses.length, 1);
    assert.equal(responses[0].status, 'error');
    assert.equal(responses[0].message, 'Database unavailable');
});
