const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function fixture(find) {
    const socket = new EventEmitter();
    const module = { exports: {} };
    const dependencies = { '../../models': { line: { find } }, mongoose: {}, '../session': {} };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../socket/event/line.js'), 'utf8'), {
        module, require: name => dependencies[name],
    });
    module.exports(socket, {});
    return socket;
}

test('production line fetch performs one query and acknowledges the returned records', async () => {
    const query = { isActive: true }, rows = [{ _id: 'line-one' }];
    let queries = 0;
    const socket = fixture(async received => {
        queries++;
        assert.equal(received, query);
        return rows;
    });
    const responses = [];
    socket.emit('lines:get', query, result => responses.push(result));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(queries, 1);
    assert.equal(responses.length, 1);
    assert.equal(responses[0].status, 'success');
    assert.equal(responses[0].payload, rows);
});

test('production line fetch reports both synchronous and asynchronous query failures', async () => {
    for (const find of [() => { throw new Error('Invalid query'); }, async () => { throw new Error('Read failed'); }]) {
        const socket = fixture(find), responses = [];
        socket.emit('lines:get', {}, result => responses.push(result));
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(responses.length, 1);
        assert.equal(responses[0].status, 'error');
        assert.match(responses[0].message, /Invalid query|Read failed/);
    }
});
