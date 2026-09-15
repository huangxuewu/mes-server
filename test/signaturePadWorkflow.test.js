const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { createSignaturePadWorkflow, parseWorkflowBarcode } = require('../utils/signaturePadWorkflow');

const setup = () => {
    let records = ['001', '002'].map((dc, index) => ({ _id: `record-${index}`, poNumber: `12345-${dc}`,
        loads: [{ shipmentId: `SHIP-${index}`, loadNumber: 'LOAD-1', status: 'Pending', carrierSCAC: 'ABCD',
            items: [{ styleCode: 'STYLE-1234', description: 'Pillow', quantity: 120, casePack: 12 }],
            checklist: { printed: { status: true, timestamp: '2026-09-01' } } }] }));
    records.push({ _id: 'other', poNumber: '12345-001', loads: [{ ...structuredClone(records[0].loads[0]), shipmentId: 'OTHER', loadNumber: 'LOAD-2' }] });
    let failAt = 0, writes = 0, ended = 0, sequence = 0, counterWrites = 0;
    const models = { outbound: {
        find(query) { return { session() { return this; }, lean: async () => structuredClone(records.filter(record => record.loads.some(load =>
            Object.entries(query).every(([key, value]) => key.split('.').slice(1).reduce((row, part) => row?.[part], load) === value)))) }; },
        async startSession() { return {
            async withTransaction(work) {
                const before = structuredClone(records);
                try { await work(); } catch (error) { records = before; throw error; }
            },
            async endSession() { ended++; },
        }; },
        async updateOne(query, update, options) {
            assert.ok(options.session, 'All updates are transactional');
            if (++writes === failAt) throw new Error('Write failed');
            const record = records.find(record => record._id === query._id);
            const target = record?.loads.find(load => load.shipmentId === query.loads.$elemMatch.shipmentId && load.loadNumber === query.loads.$elemMatch.loadNumber);
            if (!target) return { matchedCount: 0 };
            assert.deepEqual(options.arrayFilters, [{ 'target.shipmentId': target.shipmentId, 'target.loadNumber': target.loadNumber }]);
            for (const [key, value] of Object.entries(update.$set)) {
                if (key === 'loads.$[target].updatedAt') target.updatedAt = value;
                else {
                    const parts = key.split('.').slice(2); let current = target;
                    for (const part of parts.slice(0, -1)) current = current[part] ||= {};
                    current[parts.at(-1)] = structuredClone(value);
                }
            }
            return { matchedCount: 1 };
        },
    }, counter: { async findByIdAndUpdate(id, update) {
        assert.equal(id, 'signature-pad-checklist'); counterWrites++;
        sequence += update.$inc.sequence;
        return { sequence };
    } } };
    const device = { _id: 'device-1' };
    const secret = 'test-workflow-secret';
    const workflow = createSignaturePadWorkflow({ models, secret });
    return { workflow, device, secret, models, records: () => records, writes: () => writes, ended: () => ended,
        failAt: value => { failAt = value; }, counterWrites: () => counterWrites,
        lookup: barcode => workflow.lookup(device, barcode),
        confirm: (grant, shipmentIds = ['SHIP-0']) => workflow.confirm(device, { grant, shipmentIds }) };
};

test('final prefix mapping and scanner normalization are strict', () => {
    assert.deepEqual(parseWorkflowBarcode(']C1(402)LOAD-1\r\n'), { action: 'inspected', loadNumber: 'LOAD-1', shipmentId: '' });
    assert.deepEqual(parseWorkflowBarcode(']C0403LOAD-1|SHIP-0\x1d'), { action: 'labeled', loadNumber: 'LOAD-1', shipmentId: 'SHIP-0' });
    assert.equal(parseWorkflowBarcode('404LOAD-1').action, 'picked');
    for (const code of [null, '', '40112345', '405LOAD-1', '403LOAD-1', '404LOAD-1|SHIP-0', '402LOAD-1|SHIP-0', '402', '403LOAD-1|SHIP-0|OTHER', '4'.repeat(129)])
        assert.throws(() => parseWorkflowBarcode(code), /invalidBarcode/);
});

test('lookup returns every load DC and item box quantities without writing', async () => {
    const t = setup();
    const result = await t.lookup('404LOAD-1');
    assert.equal(result.action, 'picked'); assert.equal(result.shipments.length, 2);
    assert.equal(result.shipments[0].items[0].boxes, 10);
    assert.equal(result.shipments[0].checklist.inspected, undefined);
    assert.equal(t.writes(), 0);
});

test('partial confirmation changes only selected DC and field; retries retain timestamps', async () => {
    const t = setup();
    const { grant } = await t.lookup('404LOAD-1');
    const first = await t.confirm(grant);
    const retry = await t.confirm(grant);
    assert.deepEqual(retry, first); assert.equal(t.writes(), 1);
    assert.equal(t.records()[0].loads[0].checklist.picked.status, true);
    assert.equal(t.records()[1].loads[0].checklist.picked, undefined);
    assert.equal(t.records()[2].loads[0].checklist.picked, undefined);
    assert.deepEqual(t.records()[0].loads[0].checklist.printed, { status: true, timestamp: '2026-09-01' });
    assert.equal(t.records()[0].loads[0].status, 'Pending');
    assert.equal(t.ended(), 2);
});

test('item lookup matches desktop inheritance while explicit empty allocations remain invalid', async () => {
    const t = setup(); const record = t.records()[0];
    record.items = record.loads[0].items; delete record.loads[0].items;
    assert.equal((await t.lookup('403LOAD-1|SHIP-0')).shipments[0].items[0].boxes, 10);
    record.loads[0].items = [];
    await assert.rejects(t.lookup('403LOAD-1|SHIP-0'), /workflowNotReady/);
});

test('picking and inspection skip closed DCs, including a closed barcode anchor, while labeling stays blocked', async () => {
    for (const [prefix, action] of [['404', 'picked'], ['402', 'inspected']]) for (const status of ['Completed', 'Cancelled']) {
        const t = setup();
        const closed = t.records()[0].loads[0];
        closed.status = status; closed.items = [];
        closed.checklist[action] = { barcode: prefix + '000000001', barcodeLoadNumber: 'LOAD-1', status: false };
        const before = structuredClone(closed);
        const lookup = await t.lookup(prefix + '000000001');
        assert.deepEqual(lookup.shipments.map(row => row.shipmentId), ['SHIP-1']);
        await assert.rejects(t.confirm(lookup.grant, ['SHIP-0']), /invalidMessage/);
        await t.confirm(lookup.grant, ['SHIP-1']);
        assert.equal(t.records()[1].loads[0].checklist[action].status, true);
        assert.deepEqual(t.records()[0].loads[0], before);
        await assert.rejects(t.lookup('403LOAD-1|SHIP-0'), /workflowClosed/);
        t.records()[1].loads[0].status = 'Completed';
        await assert.rejects(t.lookup(prefix + '000000001'), /workflowClosed/);
    }
});

test('inspection and labeling work independently; labels target one shipment within its load', async () => {
    const t = setup();
    await t.confirm((await t.lookup('402LOAD-1')).grant, ['SHIP-0', 'SHIP-1']);
    assert.ok(t.records().slice(0, 2).every(record => record.loads[0].checklist.inspected.status));
    assert.equal(t.records()[0].loads[0].checklist.picked, undefined);
    const label = await t.lookup('403LOAD-1|SHIP-1');
    assert.equal(label.shipments.length, 1);
    await t.confirm(label.grant, ['SHIP-1']);
    assert.equal(t.records()[1].loads[0].checklist.labeled.status, true);
    assert.equal(t.records()[0].loads[0].checklist.labeled, undefined);
    await assert.rejects(t.confirm(label.grant, ['SHIP-0']), /invalidMessage/);
    await assert.rejects(t.lookup('403LOAD-2|SHIP-1'), /workflowNotFound/);
});

test('invalid selections, tampered/expired grants and other devices cannot write', async () => {
    const t = setup();
    const { grant } = await t.lookup('404LOAD-1');
    for (const ids of [[], ['SHIP-0', 'SHIP-0'], ['OTHER'], [null]]) await assert.rejects(t.confirm(grant, ids), /invalidMessage/);
    await assert.rejects(t.confirm(grant + 'tamper'), /scanExpired/);
    await assert.rejects(t.workflow.confirm({ _id: 'device-2' }, { grant, shipmentIds: ['SHIP-0'] }), /deviceUnauthorized/);
    const payload = jwt.verify(grant, t.secret); delete payload.exp; delete payload.iat;
    await assert.rejects(t.confirm(jwt.sign(payload, t.secret, { expiresIn: -1 })), /scanExpired/);
    await assert.rejects(t.confirm(jwt.sign({ ...payload, kind: 'signature-pad-bol' }, t.secret)), /deviceUnauthorized/);
    assert.equal(t.writes(), 0);
});

test('changed membership, quantities, identity and closed shipments require another review', async () => {
    for (const change of [
        t => { t.records()[0].loads[0].items[0].quantity++; },
        t => { t.records()[0].loads[0].loadNumber = 'REASSIGNED'; },
        t => { t.records()[0].loads[0].status = 'Completed'; },
        t => { t.records()[0].loads[0].status = 'Cancelled'; },
        t => { t.records()[0].loads[0].carrierSCAC = 'OTHER'; },
        t => { t.records().push({ _id: 'new', poNumber: '12345-003', loads: [{ ...structuredClone(t.records()[0].loads[0]), shipmentId: 'SHIP-3' }] }); },
    ]) {
        const t = setup(); const { grant } = await t.lookup('402LOAD-1'); change(t);
        await assert.rejects(t.confirm(grant), /workflowChanged|workflowClosed/); assert.equal(t.writes(), 0);
    }
});

test('ambiguous identities, missing records and invalid quantities cannot be confirmed', async () => {
    const t = setup();
    await assert.rejects(t.lookup('404MISSING'), /workflowNotFound/);
    t.records()[1].loads[0].shipmentId = 'SHIP-0';
    await assert.rejects(t.lookup('404LOAD-1'), /workflowAmbiguous/);
    await assert.rejects(t.lookup('403LOAD-1|SHIP-0'), /workflowAmbiguous/);
    t.records()[1].loads[0].shipmentId = 'SHIP-1'; t.records()[0].loads[0].items[0].casePack = 0;
    await assert.rejects(t.lookup('404LOAD-1'), /workflowNotReady/);
});

test('a failed multi-DC save rolls back earlier writes and closes its transaction', async () => {
    const t = setup(); const { grant } = await t.lookup('404LOAD-1'); t.failAt(2);
    await assert.rejects(t.confirm(grant, ['SHIP-0', 'SHIP-1']), /Write failed/);
    assert.ok(t.records().every(record => !record.loads[0].checklist.picked)); assert.equal(t.ended(), 1);
});

test('HTTPS route contract rechecks revocation and active Office permission before confirmation', async () => {
    const express = require('express');
    const { createHash } = require('node:crypto');
    const t = setup();
    const token = 'a'.repeat(64);
    const device = { _id: 'device-1', ownerId: 'owner', revoked: false, tokenHash: createHash('sha256').update(token).digest('hex') };
    const user = { _id: 'owner', status: 'Active', role: 'User', permission: { module: ['office'] } };
    t.models.signaturePadDevice = { findOne: query => ({ lean: async () => !device.revoked && query.tokenHash === device.tokenHash ? device : null }) };
    t.models.user = { findById: () => ({ lean: async () => user }) };
    const app = express(); app.use('/signature-pad', require('../routes/signaturePad')(t.models));
    const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    const post = (operation, body, credential = token) => fetch(`http://127.0.0.1:${server.address().port}/signature-pad/workflow/${operation}`, {
        method: 'POST', headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    try {
        assert.equal((await post('lookup', { barcode: '404LOAD-1' }, 'invalid')).status, 401);
        const lookup = await post('lookup', { barcode: '404LOAD-1' });
        assert.equal(lookup.status, 200); assert.equal(lookup.headers.get('cache-control'), 'no-store');
        const { payload } = await lookup.json();
        const input = { grant: payload.grant, shipmentIds: ['SHIP-0'] };
        device.revoked = true; assert.equal((await post('confirm', input)).status, 401);
        device.revoked = false; user.status = 'Inactive'; assert.equal((await post('confirm', input)).status, 401);
        user.status = 'Active'; user.permission.module = []; assert.equal((await post('confirm', input)).status, 401);
        assert.equal(t.writes(), 0);
        user.permission.module = ['office'];
        const saved = await post('confirm', input);
        assert.equal(saved.status, 200); assert.equal((await saved.json()).payload.shipments[0].status, true);
        assert.equal(t.writes(), 1);
    } finally { await new Promise(resolve => server.close(resolve)); }
});
