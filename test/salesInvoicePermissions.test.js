const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { invoiceVisibility } = require('../utils/edi/invoiceVisibility');
const { hasPermission } = require('../socket/session');

const detail = () => ({
    poNumber: 'PO1', ready: true, invoiceDate: '2026-09-12', fingerprint: 'baseline', reviewFingerprint: 'review',
    totalCents: 123456, pdfPath: '/invoice.pdf', json: { secret: 'sensitive-json' },
    erpUrl: 'https://erp.example/invoice', orderfulUrl: 'https://orderful.example/invoice',
    canSavePdf: true, bolUrls: { LOAD1: 'https://bol.example/document' },
    invoice: { id: '810', validation: 'VALID', delivery: 'SENT', acknowledgment: 'ACCEPTED', secret: 'sensitive-invoice' },
    preview: { totalCents: 123456, adjustmentCents: 99, items: [{ line: 1, quantity: 12, externalId: 'ITEM1', unitPrice: '102.88', lineTotalCents: 123456 }] },
    review: { invoiceNumber: 'INV1', scac: 'SOCS', bolNumber: 'BOL1', loadNumber: 'LOAD1', items: [{ line: 1, quantity: 12 }] },
    erpSource: { vendor_name: 'Target', payment_terms_discount: 'sensitive-discount',
        destinationCenter: { dc_name: 'DC1', secret: 'sensitive-address' },
        load_shipments: [{ created_at: '2026-09-11', secret: 'sensitive-shipment',
            load: { load_number: 'LOAD1', bol_number: 'BOL1', cost: 'sensitive-load' },
            shipment_tracking: { asn_sent_at: '2026-09-11', freight: 'sensitive-freight' },
            shipment_notice: { assigned_scac: 'SOCS', bol: 'BOL1', total: 'sensitive-notice' } }] },
});
const user = (amounts = false, submit = false, access = true) => ({ _id: 'one', role: 'Employee', permission: {
    access: access ? ['financial.page.access'] : [], view: amounts ? ['finance.salesInvoice.amounts'] : [],
    create: submit ? ['finance.salesInvoice.submit'] : [],
} });
const fixture = (actor, run = async () => detail()) => {
    const handlers = {}, calls = [];
    const socket = { data: { sessionGeneration: 1 }, on: (event, handler) => { handlers[event] = handler; } };
    const state = { actor };
    const flow = Object.fromEntries(['list', 'get', 'refresh', 'submit', 'savePdf', 'download'].map(action => [action, async (...args) => {
        calls.push(action);
        return run(action, ...args);
    }]));
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../socket/event/salesInvoice.js'), 'utf8'), {
        module, require: name => name.endsWith('/session') ? { hasPermission, getActiveSessionUser: async () => {
            if (!state.actor) throw new Error('Sign in to continue');
            return state.actor;
        } } : name.endsWith('/invoiceVisibility') ? { invoiceVisibility } : flow,
    });
    module.exports(socket);
    return { state, socket, calls, call: (action, input = {}) => new Promise(resolve => handlers[`sales-invoice:${action}`](input, resolve)) };
};

test('restricted projections omit nested financial data and retain review and document availability', () => {
    const source = detail();
    const safe = invoiceVisibility(source, false);
    const json = JSON.stringify(safe);
    for (const secret of ['123456', '102.88', 'sensitive-', '/invoice.pdf', 'erp.example', 'orderful.example', 'unitPrice', 'totalCents', 'adjustmentCents']) assert.ok(!json.includes(secret), secret);
    assert.equal(safe.amountsVisible, false);
    assert.equal(safe.hasPdf, true);
    assert.equal(safe.hasJson, true);
    assert.equal(safe.preview.items[0].quantity, 12);
    assert.equal(safe.erpSource.load_shipments[0].load.load_number, 'LOAD1');
    assert.deepEqual(safe.review, source.review);
    assert.equal(source.preview.items[0].unitPrice, '102.88');
    assert.equal(invoiceVisibility({ rows: [source] }, false).rows[0].amountsVisible, false);
    assert.equal(invoiceVisibility(source, true).preview.totalCents, 123456);
});

for (const amounts of [false, true]) for (const submit of [false, true]) test(`permissions are independent: amounts=${amounts}, submit=${submit}`, async () => {
    const f = fixture(user(amounts, submit));
    for (const action of ['list', 'get', 'refresh']) {
        const response = await f.call(action, { amountsVisible: true, permission: { view: ['finance.salesInvoice.amounts'] } });
        assert.equal(response.status, 'success');
        assert.equal(response.payload.amountsVisible, amounts);
        assert.equal(response.payload.totalCents, amounts ? 123456 : undefined);
    }
    for (const action of ['submit', 'savePdf']) assert.equal((await f.call(action)).status, submit ? 'success' : 'error');
    assert.equal((await f.call('download')).status, amounts ? 'success' : 'error');
    if (!submit) assert.ok(!f.calls.includes('submit'));
    if (!amounts) assert.ok(!f.calls.includes('download'));
});

test('page access is mandatory and Admin/System retain existing bypass', async () => {
    const denied = fixture(user(true, true, false));
    for (const action of ['list', 'get', 'refresh', 'submit', 'savePdf', 'download']) assert.equal((await denied.call(action)).status, 'error');
    assert.equal(denied.calls.length, 0);
    for (const role of ['Admin', 'System']) {
        const f = fixture({ _id: 'admin', role });
        assert.equal((await f.call('get')).payload.amountsVisible, true);
        assert.equal((await f.call('submit')).status, 'success');
    }
});

test('permission downgrade during a read redacts the response using current grants', async () => {
    let finish;
    const f = fixture(user(true), () => new Promise(resolve => { finish = resolve; }));
    const pending = f.call('get');
    while (!finish) await Promise.resolve();
    f.state.actor = user(false);
    finish(detail());
    const response = await pending;
    assert.equal(response.payload.amountsVisible, false);
    assert.equal(response.payload.totalCents, undefined);
});

test('submission authorization callback rejects permission revocation before side effects', async () => {
    let authorize, finish;
    const f = fixture(user(false, true), async (action, input, actor, guard) => {
        authorize = guard;
        await new Promise(resolve => { finish = resolve; });
        await authorize();
        assert.fail('Unauthorized side effect');
    });
    const pending = f.call('submit');
    while (!finish) await Promise.resolve();
    f.state.actor = user(false, false);
    finish();
    assert.equal((await pending).status, 'error');
});

test('session switches reject pending responses and restricted errors cannot disclose amounts', async () => {
    const switched = fixture(user(true), async () => { switched.socket.data.sessionGeneration++; return detail(); });
    assert.equal((await switched.call('get')).message, 'Session changed');
    const restricted = fixture(user(), async () => { throw new Error('ERP returned price 123456'); });
    assert.ok(!(await restricted.call('get')).message.includes('123456'));
});
