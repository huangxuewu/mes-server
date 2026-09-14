const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const sharp = require('sharp');
const { createSignaturePadAccess, normalizeBolBarcode } = require('../utils/signaturePadAccess');
const saveBolDraft = require('../utils/saveBolDraft');
const number = '84017970842360107';
const barcode = `401${number}`;
const image = sharp({ create: { width: 80, height: 20, channels: 4, background: '#142538' } }).png().toBuffer().then(buffer => `data:image/png;base64,${buffer.toString('base64')}`);
const read = (row, key) => key.split('.').reduce((value, part) => value?.[part], row);
const matches = (row, query) => Object.entries(query).every(([key, value]) => key === '$or' ? value.some(item => matches(row, item))
    : value?.$elemMatch ? row[key]?.some(item => matches(item, value.$elemMatch)) : read(row, key) === value);
const write = (row, key, value) => { const parts = key.split('.'); const last = parts.pop(); const target = parts.reduce((object, part) => object[part] ||= {}, row); target[last] = structuredClone(value); };
const setup = () => {
    const user = { _id: 'operator', role: 'Admin', status: 'Active' };
    const device = { _id: 'pad-one' };
    const raw = { bill_of_lading_number: number, load_number: 'LOAD-1', carrier_name: 'Hub Group', ship_to: { name: 'Warehouse' }, shipper_signature: 'original-shipper', driver_signature: '', items: [{ quantity: 24 }] };
    let records = [1, 2].map(id => ({ _id: `outbound-${id}`, loads: [{ shipmentId: `shipment-${id}`, loadNumber: 'LOAD-1', status: 'Loading', bol: { number, rawData: structuredClone(raw) } }] }));
    const devices = new Map();
    let writes = 0, failAt = 0, ended = 0;
    const outbound = {
        find(query) {
            const selected = () => records.filter(record => query.$or ? record.loads.some(load => load.bol?.number === number || load.bol?.rawData?.bill_of_lading_number === number) : matches(record, query));
            return { session() { return this; }, lean: async () => structuredClone(selected()) };
        },
        startSession: async () => ({
            withTransaction: async callback => { const backup = structuredClone(records); try { await callback(); } catch (error) { records = backup; throw error; } },
            endSession: async () => { ended++; },
        }),
        async updateOne(query, update, options) {
            assert.ok(options.session, 'BOL writes must be transactional');
            if (++writes === failAt) throw new Error('simulated write failure');
            const record = records.find(record => matches(record, query));
            if (!record) return { matchedCount: 0 };
            const filter = Object.fromEntries(Object.entries(options.arrayFilters[0]).map(([key, value]) => [key.replace(/^target\./, ''), value]));
            for (const load of record.loads.filter(load => matches(load, filter))) for (const [key, value] of Object.entries(update.$set)) write(load, key.replace('loads.$[target].', ''), value);
            return { matchedCount: 1 };
        },
        async findOneAndUpdate(query, update, options) { await this.updateOne(query, update, options); return records.find(record => record._id === query._id); },
    };
    const signaturePadDevice = {
        findOne: query => ({ lean: async () => [...devices.values()].find(row => matches(row, query)) }),
        async findOneAndUpdate(query, update) {
            const previous = devices.get(query._id);
            if (previous && !matches(previous, query)) throw Object.assign(new Error('duplicate'), { code: 11000 });
            devices.set(query._id, { _id: query._id, ...update.$set });
        },
        async updateOne(query, update) { const row = [...devices.values()].find(row => matches(row, query)); if (row) Object.assign(row, update.$set); },
    };
    const models = { outbound, signaturePadDevice, user: { findById: () => ({ lean: async () => user }) } };
    const access = createSignaturePadAccess({ models, secret: 'test-only-signing-key', getUser: async () => user });
    return { access, models, device, user, raw, records: () => records, devices, writes: () => writes, ended: () => ended, failWrite: value => { failAt = value; },
        lookup: () => access.lookup(device, barcode), input: async grant => ({ grant, submissionId: randomUUID(), image: await image }) };
};

test('reads the printed MES Code 128, human-readable AI, and scanner AIM prefixes', () => {
    for (const value of [barcode, `(401)${number}`, `]C0${barcode}\r\n`, `]C1${barcode}`, `(401)8401 7970 8423 6010 7`]) assert.equal(normalizeBolBarcode(value), number);
    for (const value of ['', number, '(400)123', '401', 'https://example.com', null, 'x'.repeat(129)]) assert.throws(() => normalizeBolBarcode(value), /invalidBarcode/);
});

test('durable device authorization hashes tokens and enforces owner, revocation and active permissions', async () => {
    const t = setup(); const credential = await t.access.authorize(t.user, t.device._id);
    assert.notEqual(t.devices.get(t.device._id).tokenHash, credential.token);
    assert.equal((await t.access.authenticate(credential.token))._id, t.device._id);
    await assert.rejects(t.access.authorize({ ...t.user, _id: 'other', role: 'Employee', permission: { module: ['office'] } }, t.device._id), /deviceUnauthorized/);
    t.user.status = 'Inactive'; await assert.rejects(t.access.authenticate(credential.token), /deviceUnauthorized/); t.user.status = 'Active';
    await t.access.revoke(t.user, t.device._id); await assert.rejects(t.access.authenticate(credential.token), /deviceUnauthorized/);
    const next = await t.access.authorize(t.user, t.device._id); assert.notEqual(next.token, credential.token);
    t.user.role = 'System'; await assert.rejects(t.access.authenticate(next.token), /deviceUnauthorized/);
});

test('lookup returns document details and updates only the driver signature on every merged copy', async () => {
    const t = setup(); const found = await t.lookup();
    assert.equal(found.bolNumber, number); assert.equal(found.loadNumber, 'LOAD-1'); assert.equal(found.carrierName, 'Hub Group'); assert.equal(found.copies, 2);
    const input = await t.input(found.grant); const saved = await t.access.sign(t.device, input);
    assert.equal(saved.documentId, found.documentId);
    for (const record of t.records()) {
        const raw = record.loads[0].bol.rawData;
        assert.equal(raw.driver_signature, input.image); assert.equal(raw.driver_signature_date, saved.savedAt);
        assert.equal(raw.shipper_signature, t.raw.shipper_signature); assert.deepEqual(raw.items, t.raw.items);
    }
    assert.equal(t.ended(), 1);
    assert.deepEqual(await t.access.sign(t.device, input), saved, 'Lost response retry returns the original receipt');
    assert.equal(t.writes(), 2, 'Idempotent retry never writes a second time');
    await assert.rejects(t.lookup(), /alreadySigned/);
    await assert.rejects(t.access.sign(t.device, { ...input, submissionId: randomUUID() }), /alreadySigned/);
});

test('completed loads are rejected both before lookup and if completed while the driver is signing', async () => {
    const t = setup(); const found = await t.lookup();
    t.records()[1].loads[0].status = 'Completed';
    await assert.rejects(t.lookup(), /bolCompleted/);
    await assert.rejects(t.access.sign(t.device, await t.input(found.grant)), /bolCompleted/);
    assert.equal(t.writes(), 0);
});

test('changed drafts, wrong devices, invalid images and conflicting BOL numbers cannot be signed', async () => {
    const t = setup(); const found = await t.lookup(); const input = await t.input(found.grant);
    await assert.rejects(t.access.sign({ _id: 'other' }, input), /deviceUnauthorized/);
    await assert.rejects(t.access.sign(t.device, { ...input, image: 'data:image/png;base64,YmFk' }), /invalidImage/);
    for (const record of t.records()) record.loads[0].bol.rawData.carrier_name = 'Changed carrier';
    await assert.rejects(t.access.sign(t.device, input), /bolChanged/);
    t.records()[1].loads[0].loadNumber = 'OTHER'; await assert.rejects(t.lookup(), /ambiguousBol/);
    assert.equal(t.writes(), 0);
});

test('a failed merged write rolls back all signatures and supports retry', async () => {
    const t = setup(); const found = await t.lookup(); const input = await t.input(found.grant); t.failWrite(2);
    await assert.rejects(t.access.sign(t.device, input), /simulated/);
    assert.ok(t.records().every(record => !record.loads[0].bol.rawData.driver_signature));
    await t.access.sign(t.device, input);
    assert.ok(t.records().every(record => record.loads[0].bol.rawData.driver_signature === input.image));
});

test('stale desktop drafts cannot erase a scanned signature; current drafts preserve it', async () => {
    const t = setup(); const found = await t.lookup(); await t.access.sign(t.device, await t.input(found.grant));
    await assert.rejects(saveBolDraft(t.models.outbound, { loadNumber: 'LOAD-1' }, { 'bol.rawData': t.raw }), /alreadySigned/);
    await assert.rejects(saveBolDraft(t.models.outbound, { loadNumber: 'LOAD-1' }, { 'bol.rawData': null }), /alreadySigned/);
    await assert.rejects(saveBolDraft(t.models.outbound, { shipmentId: 'shipment-1' }, { bol: { number, rawData: t.raw } }), /alreadySigned/);
    const draft = structuredClone(t.records()[0].loads[0].bol.rawData); draft.carrier_name = 'Updated carrier';
    await saveBolDraft(t.models.outbound, { loadNumber: 'LOAD-1' }, { 'bol.rawData': draft });
    assert.ok(t.records().every(record => record.loads[0].bol.rawData.carrier_name === 'Updated carrier'));
    assert.ok(t.records().every(record => record.loads[0].bol.rawData.driver_signature));
});

test('HTTPS API authentication rejects anonymous and revoked devices before looking up a BOL', async () => {
    const t = setup(); const express = require('express'); const app = express();
    app.use('/signature-pad', require('../routes/signaturePad')(t.models));
    const server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
    try {
        const url = `http://127.0.0.1:${server.address().port}/signature-pad`;
        assert.equal((await fetch(`${url}/bol/lookup`, { method: 'POST' })).status, 401);
        const credential = await t.access.authorize(t.user, t.device._id);
        const headers = { Authorization: `Bearer ${credential.token}`, 'Content-Type': 'application/json' };
        const response = await fetch(`${url}/bol/lookup`, { method: 'POST', headers, body: JSON.stringify({ barcode }) });
        assert.equal(response.status, 200); assert.equal((await response.json()).payload.bolNumber, number);
        assert.equal((await fetch(`${url}/revoke`, { method: 'POST', headers, body: '{}' })).status, 200);
        assert.equal((await fetch(`${url}/bol/lookup`, { method: 'POST', headers, body: JSON.stringify({ barcode }) })).status, 401);
    } finally { await new Promise(resolve => server.close(resolve)); }
});

test('printing returns only the matching saved scan and rejects unsigned, stale or revoked receipts', async () => {
    const t = setup(); await t.access.authorize(t.user, t.device._id);
    const found = await t.lookup(); const input = await t.input(found.grant);
    const request = { grant: found.grant, submissionId: input.submissionId, deviceId: t.device._id };
    await assert.rejects(t.access.printData(t.user, request), /bolChanged/);
    await t.access.sign(t.device, input);
    const printable = await t.access.printData(t.user, request);
    assert.equal(printable.documentId, found.documentId); assert.equal(printable.bol.driver_signature, input.image);
    await assert.rejects(t.access.printData(t.user, { ...request, deviceId: 'other' }), /deviceUnauthorized/);
    await assert.rejects(t.access.printData(t.user, { ...request, submissionId: randomUUID() }), /bolChanged/);
    await assert.rejects(t.access.printData(t.user, { ...request, grant: 'invalid' }), /scanExpired/);
    t.records()[1].loads[0].bol.rawData.driver_signature = 'different';
    await assert.rejects(t.access.printData(t.user, request), /bolChanged/);
    t.records()[1].loads[0].bol.rawData.driver_signature = input.image;
    await t.access.revoke(t.user, t.device._id);
    await assert.rejects(t.access.printData(t.user, request), /deviceUnauthorized/);
});

test('a deleted printed BOL is not found even when its number remains on the shipment', async () => {
    const t = setup(); const found = await t.lookup();
    await saveBolDraft(t.models.outbound, { loadNumber: 'LOAD-1' }, { 'bol.rawData': null, 'bol.url': null });
    assert.ok(t.records().every(record => record.loads[0].bol.number === number));
    await assert.rejects(t.lookup(), /bolNotFound/);
    await assert.rejects(t.access.sign(t.device, await t.input(found.grant)), /bolNotFound/);
    for (const record of t.records()) delete record.loads[0].bol;
    await assert.rejects(t.lookup(), /bolNotFound/);
});

test('a partially missing merged BOL remains unready instead of signing a remaining copy', async () => {
    const t = setup(); t.records()[1].loads[0].bol.rawData = null;
    await assert.rejects(t.lookup(), /bolNotReady/); assert.equal(t.writes(), 0);
});

test('explicit deletion releases signed merged BOLs so a replacement can be signed', async () => {
    const t = setup();
    const found = await t.lookup();
    await t.access.sign(t.device, await t.input(found.grant));
    for (const record of t.records()) {
        record.loads[0].status = 'Completed';
        Object.assign(record.loads[0].bol, { url: 'saved.pdf', uploadedAt: '2026-09-14' });
    }
    await saveBolDraft(t.models.outbound, { loadNumber: 'LOAD-1' }, { 'bol.rawData': null, 'bol.url': null });
    for (const record of t.records()) {
        assert.deepEqual(record.loads[0].bol, { number, rawData: null, url: null, uploadedAt: null });
        assert.equal(record.loads[0].status, 'Picked Up');
    }
    await assert.rejects(t.lookup(), /bolNotFound/);
    const replacement = { ...t.raw, shipper_signature: '', carrier_name: 'Replacement carrier' };
    await saveBolDraft(t.models.outbound, { loadNumber: 'LOAD-1' }, { 'bol.rawData': replacement });
    const next = await t.lookup();
    await t.access.sign(t.device, await t.input(next.grant));
    assert.ok(t.records().every(record => record.loads[0].bol.rawData.driver_signature));
});

test('single BOL deletion preserves other shipments and failed merged deletion rolls back', async () => {
    const t = setup();
    const found = await t.lookup();
    await t.access.sign(t.device, await t.input(found.grant));
    const before = structuredClone(t.records());
    t.failWrite(t.writes() + 2);
    await assert.rejects(saveBolDraft(t.models.outbound, { loadNumber: 'LOAD-1' }, { 'bol.rawData': null, 'bol.url': null }), /simulated/);
    assert.deepEqual(t.records(), before);
    await saveBolDraft(t.models.outbound, { shipmentId: 'shipment-1' }, { 'bol.rawData': null, 'bol.url': null });
    assert.equal(t.records()[0].loads[0].bol.rawData, null);
    assert.equal(t.records()[0].loads[0].status, 'Loading');
    assert.deepEqual(t.records()[1], before[1]);
});
