const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHash } = require('node:crypto');
const test = require('node:test');
const heatshrink = require('../addon/labelMaker/finishProduct/assets/heatshrink.js');
const source = fs.readFileSync(path.join(__dirname, '../addon/labelMaker/finishProduct/assets/rw403b.js'), 'utf8');

const fixture = () => {
    const writes = [], serviceIds = [], characteristicIds = [];
    let options, disconnect;
    const device = { name: 'RW403B test', addEventListener: (_event, handler) => { disconnect = handler; } };
    const channel = { properties: { notify: true }, startNotifications: async () => {}, writeValue: async bytes => {
        if (!device.gatt.connected) throw new Error('Disconnected');
        writes.push(Buffer.from(bytes));
    } };
    device.gatt = { connected: false, connect: async () => {
        device.gatt.connected = true;
        return { getPrimaryService: async id => { serviceIds.push(id); return { getCharacteristic: async id => { characteristicIds.push(id); return channel; } }; } };
    } };
    const window = { heatshrink };
    vm.runInNewContext(source, { window, Uint8Array, navigator: { bluetooth: { requestDevice: async value => { options = value; return device; } } }, setTimeout: resolve => resolve() });
    const printer = window.createLabelPrinter({ printerSelector: { classList: { toggle() {} } }, printerName: {} }, () => {});
    return { printer, writes, serviceIds, characteristicIds, get options() { return options; }, disconnect: () => { device.gatt.connected = false; disconnect(); } };
};

test('shared RW403B module preserves the original GATT profile and exact label bytes', async () => {
    // The bundled compressor initializes its WebAssembly asynchronously.
    for (let attempt = 0; ; attempt++) {
        try { heatshrink.compress(new Uint8Array([0])); break; }
        catch (error) { if (attempt >= 20) throw error; await new Promise(resolve => setTimeout(resolve, 10)); }
    }
    const context = fixture(); await context.printer.connect();
    assert.equal(context.options.filters[0].namePrefix, 'RW403B');
    assert.deepEqual(context.serviceIds, [0xabf0]);
    assert.deepEqual(context.characteristicIds, [0xabf4, 0xabf1, 0xabf3]);
    const width = 812, height = 1218, data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const index = (y * width + x) * 4;
        data[index] = data[index + 1] = data[index + 2] = (x * 37 + y * 17) % 251 < 89 ? 0 : 255;
        data[index + 3] = 255;
    }
    await context.printer.print({ width, height, getContext: () => ({ getImageData: () => ({ data }) }) });
    // Reference captured from the project’s original tested encoder, before extraction.
    assert.equal(context.writes.length, 51);
    assert.equal(Buffer.concat(context.writes).length, 20237);
    assert.equal(createHash('sha256').update(Buffer.concat(context.writes)).digest('hex'), '9e95622b936ded8fffaa79872f791c2669b98514db2b8c254d9155c88029b416');
});

test('disconnecting a shared printer blocks new transmissions', async () => {
    const context = fixture(); await context.printer.connect();
    assert.equal(context.printer.isConnected(), true);
    context.disconnect();
    assert.equal(context.printer.isConnected(), false);
    await assert.rejects(context.printer.print({}), /Connect the printer/);
    assert.equal(context.writes.length, 0);
});
