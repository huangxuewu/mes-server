const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../addon/labelMaker/finishProduct/assets/mobile.js'), 'utf8');
const line = '111111111111111111111111';
const sessionKey = `productionMobile:session:${line}`;
const flush = () => new Promise(resolve => setImmediate(resolve));
const response = (status, data) => ({ ok: status < 400, status, json: async () => data });

function fixture() {
    const elements = new Map(), storage = new Map(), requests = [];
    storage.set(sessionKey, JSON.stringify({ token: 'old', employeeId: 'old', employeeName: 'Old employee' }));
    const getElement = id => {
        if (!elements.has(id)) elements.set(id, { textContent: '', value: '', classList: { toggle() {} }, addEventListener(event, handler) { this[event] = handler; } });
        return elements.get(id);
    };
    const memoryStorage = map => ({ getItem: key => map.get(key), setItem: (key, value) => map.set(key, value), removeItem: key => map.delete(key) });
    vm.runInNewContext(source, {
        location: { search: `?line=${line}` }, URLSearchParams, AbortController,
        sessionStorage: memoryStorage(storage), localStorage: memoryStorage(new Map()),
        document: { getElementById: getElement, addEventListener() {}, hidden: false },
        navigator: { onLine: true },
        window: { createLabelPrinter: () => ({ isConnected: () => false }), addEventListener() {} },
        setTimeout, clearTimeout, setInterval() {},
        fetch: (url, options) => new Promise((resolve, reject) => requests.push({ url, options, resolve, reject })),
    });
    return { elements, storage, requests };
}

for (const staleResult of ['unauthorized', 'success', 'network failure']) {
    test(`a delayed old-session ${staleResult} cannot replace or sign out a new employee`, async () => {
        const { elements, storage, requests } = fixture();
        const old = requests.shift();
        elements.get('sign-out').click();
        elements.get('employee-pin').value = '234567';
        const login = elements.get('login-form').submit({ preventDefault() {} });
        requests.shift().resolve(response(200, { token: 'new', employeeId: 'new', employeeName: 'New employee' }));
        await flush();
        const current = requests.shift();
        assert.equal(current.options.headers.Authorization, 'Bearer new');
        if (staleResult === 'unauthorized') old.resolve(response(401, { message: 'Old session expired' }));
        else if (staleResult === 'success') old.resolve(response(200, { run: { _id: 'old-run', productName: 'Wrong product' }, totals: { pillows: 99 } }));
        else old.reject(new Error('Old connection failed'));
        await flush();
        assert.equal(elements.get('refresh').disabled, true, 'The new session refresh remains pending');
        assert.equal(elements.get('message').textContent, '');
        current.resolve(response(200, { run: { _id: 'new-run', productName: 'New product', packaging: { boxesPerPallet: 2 } }, totals: { pillows: 12 } }));
        await login;
        assert.equal(JSON.parse(storage.get(sessionKey)).token, 'new');
        assert.equal(elements.get('login-form').hidden, true);
        assert.equal(elements.get('product-name').textContent, 'New product');
        assert.equal(elements.get('output-count').textContent, '12');
        assert.equal(elements.get('refresh').disabled, false);
    });
}

test('temporary service errors preserve the session, while its own 401 signs out', async () => {
    const { elements, storage, requests } = fixture();
    requests.shift().resolve(response(503, { message: 'Temporarily unavailable' }));
    await flush();
    assert.equal(JSON.parse(storage.get(sessionKey)).token, 'old');
    assert.equal(elements.get('message').textContent, 'Temporarily unavailable');
    const refresh = elements.get('refresh').click();
    requests.shift().resolve(response(401, { message: 'Sign in again' }));
    await refresh;
    assert.equal(storage.has(sessionKey), false);
    assert.equal(elements.get('login-form').hidden, false);
    assert.equal(elements.get('message').textContent, 'Sign in again');
});
