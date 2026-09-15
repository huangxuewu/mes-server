const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { createMemoryDiagnostics } = require('../utils/memoryDiagnostics');

const fixture = options => {
    const logs = [];
    let size = 100 * 1048576, clock = 1000;
    const memory = createMemoryDiagnostics({ enabled: true, now: () => clock++,
        usage: () => ({ rss: size, heapUsed: size / 2, external: size / 4, arrayBuffers: size / 8 }),
        log: line => logs.push(JSON.parse(line.slice('[Memory] '.length))), ...options });
    return { memory, logs, grow: () => { size += 20 * 1048576; } };
};

test('wrapped operations preserve receivers, arguments, sync values, callbacks and rejection identity', async () => {
    const f = fixture(), receiver = {}, input = { secret: 'never-log-this' }, error = new Error('private error body');
    const fn = f.memory.wrap('socket:test', function (data, callback) {
        assert.equal(this, receiver); assert.equal(data, input); callback(data); f.grow(); return data;
    });
    let reply;
    assert.equal(fn.call(receiver, input, value => { reply = value; }), input);
    assert.equal(reply, input);
    assert.throws(f.memory.wrap('sync:failure', () => { throw error; }), value => value === error);
    await assert.rejects(f.memory.wrap('async:failure', async () => { throw error; })(), value => value === error);
    f.memory.sample();
    assert.equal(f.logs.at(-1).active, 0);
    assert.equal(f.logs.at(-1).topOperations.reduce((sum, row) => sum + row.errors, 0), 2);
    assert.ok(!JSON.stringify(f.logs).includes('never-log-this'));
    assert.ok(!JSON.stringify(f.logs).includes('private error body'));
});

test('concurrent work is marked as overlapping and pending operations appear in samples', async () => {
    const f = fixture();
    let resolve;
    const pending = f.memory.wrap('slow', () => new Promise(done => { resolve = done; }))();
    f.memory.wrap('fast', () => f.grow())();
    f.memory.sample();
    assert.equal(f.logs.at(-1).active, 1);
    assert.deepEqual(f.logs.at(-1).activeOperations, [{ label: 'slow', active: 1 }]);
    resolve('result');
    assert.equal(await pending, 'result');
    const operations = f.logs.filter(row => row.type === 'operation');
    assert.ok(operations.every(row => row.overlap));
    f.memory.sample();
    assert.equal(f.logs.at(-1).active, 0);
});

test('finish is idempotent and labels and detailed log volume are bounded', () => {
    const f = fixture({ maxLabels: 2 });
    for (let i = 0; i < 50; i++) {
        const finish = f.memory.begin(`request:${i}`);
        f.grow(); finish(); finish(true);
    }
    f.memory.sample();
    const summary = f.logs.at(-1);
    assert.equal(summary.trackedLabels, 3); // Two named operations plus overflow.
    assert.equal(summary.active, 0);
    assert.equal(summary.topOperations.reduce((sum, row) => sum + row.completed, 0), 50);
    assert.equal(summary.topOperations.reduce((sum, row) => sum + row.errors, 0), 0);
    assert.equal(f.logs.filter(row => row.type === 'operation').length, 20);
    assert.equal(summary.suppressedDetails, 30);
    f.memory.sample();
    assert.equal(f.logs.at(-1).topOperations.length, 0);
});

test('socket registration restores on even after failure and keeps original socket identity', () => {
    const f = fixture(), socket = new EventEmitter(), original = socket.on;
    f.memory.registerSocket(socket, () => socket.on('test', function (input) {
        assert.equal(this, socket); assert.equal(input, 'input'); f.grow();
    }));
    assert.equal(socket.on, original);
    assert.equal(Object.hasOwn(socket, 'on'), false);
    socket.emit('test', 'input');
    assert.equal(f.logs[0].label, 'socket:test');
    assert.throws(() => f.memory.registerSocket(socket, () => { throw new Error('registration'); }), /registration/);
    assert.equal(socket.on, original);
});

test('disabled diagnostics return original functions and logger failures do not affect results', () => {
    const fn = () => 'result';
    const disabled = createMemoryDiagnostics({ enabled: false, usage: assert.fail, log: assert.fail });
    assert.equal(disabled.wrap('disabled', fn), fn);
    disabled.begin('disabled')(); disabled.sample(); disabled.start(); disabled.stop();
    const f = fixture({ log: () => { throw new Error('logger failed'); } });
    assert.equal(f.memory.wrap('enabled', () => { f.grow(); return fn(); })(), 'result');
});
