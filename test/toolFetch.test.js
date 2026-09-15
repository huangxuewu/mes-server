const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('installed tool client receives an array acknowledgement and database failures also acknowledge', async () => {
    const handlers = new Map();
    let fail = false;
    const rows = [{ _id: 'tool-one', name: 'Drill' }];
    const db = { tools: { find(query) {
        assert.equal(JSON.stringify(query), '{}');
        return { async sort() { if (fail) throw new Error('Read unavailable'); return rows; } };
    } } };
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../socket/event/inventory.js'), 'utf8'), {
        module, require: name => { assert.equal(name, '../../models'); return db; },
    });
    module.exports({ on: (event, handler) => handlers.set(event, handler) }, {});
    assert.equal(typeof handlers.get('tool:fetch'), 'function');
    let result, calls = 0;
    const ack = value => { result = value; calls++; };
    await handlers.get('tool:fetch')({}, ack);
    assert.equal(calls, 1); assert.equal(result.status, 'success'); assert.equal(result.payload, rows);
    fail = true;
    await handlers.get('tool:fetch')({}, ack);
    assert.equal(calls, 2); assert.equal(result.status, 'error'); assert.equal(result.message, 'Read unavailable');
});
