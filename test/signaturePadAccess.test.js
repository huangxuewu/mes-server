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
    const trucks = [];
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
    const hauler = { findOne: query => ({ sort() { return this; }, session() { return this; }, lean: async () => structuredClone(trucks
        .filter(truck => truck.loadNumber === query.loadNumber && truck.status !== query.status.$ne)
        .sort((a, b) => new Date(b.arrivedAt || 0) - new Date(a.arrivedAt || 0))[0] || null) }) };
    const models = { outbound, hauler, signaturePadDevice, user: { findById: () => ({ lean: async () => user }) } };
    const access = createSignaturePadAccess({ models, secret: 'test-only-signing-key', getUser: async () => user });
    return { access, models, device, user, raw, trucks, records: () => records, devices, writes: () => writes, ended: () => ended, failWrite: value => { failAt = value; },
        lookup: () => access.lookup(device, barcode), input: async grant => ({ grant, submissionId: randomUUID(), image: await image }) };
};

const uncreated = () => {
    const t = setup();
    for (const [index, record] of t.records().entries()) {
        Object.assign(record, { poNumber: `12345${index}`, name: 'Target DC', address: '123 Test Road', city: 'Test City', state: 'SC', zip: '29646' });
        Object.assign(record.loads[0], { assignedSCAC: 'HBGI', executingSCAC: '', cartons: 12 + index, pallets: 1, weight: 50 + index });
        record.loads[0].bol.rawData = null;
    }
    return t;
};

test('valid shipments create one shared BOL and require both handwritten signatures', async () => {
    const t = uncreated();
    t.trucks.push({ loadNumber: 'LOAD-1', trailer: ' GATE-123 ', seal: ' SEAL-456 ' });
    assert.equal((await t.access.lookup(t.device, barcode, true, true)).needsGeneration, true);
    assert.equal(t.writes(), 0, 'Lookup only identifies the generation step');
    const prepared = await t.access.prepare(t.device, { barcode });
    assert.equal(prepared.requiresShipper, true); assert.equal(prepared.signed, false);
    const raw = t.records()[0].loads[0].bol.rawData;
    assert.equal(raw.bill_of_lading_number, number);
    assert.equal(raw.carrier_name, 'Hub Group');
    assert.equal(raw.trailer, 'GATE-123'); assert.equal(raw.seal_number, 'SEAL-456');
    assert.equal(prepared.trailerNumber, 'GATE-123');
    assert.deepEqual(raw.grand_totals.customer_order_info, { pkgs: 25, plts: 2, weight: 101 });
    assert.equal(raw.customer_order_info[0].customer_order_number, '062-123451');
    assert.equal(raw.customer_order_info.length, 10); assert.equal(raw.commodity_info.length, 4);
    assert.deepEqual(raw, t.records()[1].loads[0].bol.rawData);
    await t.access.prepare(t.device, { barcode }); assert.equal(t.writes(), 2, 'Generation retries keep the existing document');
    const input = await t.input(prepared.grant);
    await assert.rejects(t.access.sign(t.device, input), /shipperRequired/);
    await assert.rejects(t.access.sign(t.device, { ...input, shipperImage: 'invalid' }), /invalidImage/);
    input.shipperImage = await image;
    const saved = await t.access.sign(t.device, input);
    assert.deepEqual(await t.access.sign(t.device, input), saved, 'Both signatures have idempotent retries');
    assert.equal(t.writes(), 4);
    for (const record of t.records()) {
        assert.equal(record.loads[0].bol.rawData.shipper_signature, input.shipperImage);
        assert.equal(record.loads[0].bol.rawData.driver_signature, input.image);
    }
    assert.equal((await t.access.lookup(t.device, barcode, true, true)).signed, true);
    await t.access.authorize(t.user, t.device._id);
    const print = await t.access.printData(t.user, { grant: prepared.grant, deviceId: t.device._id, submissionId: input.submissionId });
    assert.equal(print.bol.shipper_signature, input.shipperImage);
    await assert.rejects(saveBolDraft(t.models.outbound, { loadNumber: 'LOAD-1' }, { 'bol.rawData': raw }), /alreadySigned/);
    const edited = structuredClone(t.records()[0].loads[0].bol.rawData); edited.shipper_signature = 'overwritten';
    await assert.rejects(saveBolDraft(t.models.outbound, { loadNumber: 'LOAD-1' }, { 'bol.rawData': edited }), /alreadySigned/);
});

test('generation rejects incomplete, completed, ambiguous and uploaded-only shipments without writing', async () => {
    for (const change of [
        t => { t.records()[0].address = ''; },
        t => { t.records()[0].loads[0].cartons = 0; },
        t => { t.records()[0].loads[0].status = 'Completed'; },
        t => { t.records()[0].loads[0].status = 'Cancelled'; },
        t => { t.records()[0].loads[0].carrierSCAC = 'DMSP'; },
        t => { t.records()[0].loads[0].bol.url = 'https://example.com/saved.pdf'; },
        t => { t.records()[1].loads[0].loadNumber = 'OTHER'; },
        t => { t.records()[1].address = 'Different destination'; },
        t => { t.records()[1].loads[0].bol.rawData = t.raw; },
        t => { t.records().splice(0); },
    ]) {
        const t = uncreated(); change(t);
        await assert.rejects(t.access.lookup(t.device, barcode, true, true), /bolNotReady|bolCompleted|ambiguousBol|bolNotFound/);
        await assert.rejects(t.access.prepare(t.device, { barcode }), /bolNotReady|bolCompleted|ambiguousBol|bolNotFound/);
        assert.equal(t.writes(), 0);
    }
});

test('generation preserves LTL billing and consolidation destination rules', async () => {
    const t = uncreated();
    for (const record of t.records()) record.loads[0].assignedSCAC = 'CHXD';
    await t.access.prepare(t.device, { barcode });
    const raw = t.records()[0].loads[0].bol.rawData;
    assert.equal(raw.carrier_name, 'CH Robinson'); assert.equal(raw.freight_charge_terms, 'third_party');
    assert.equal(raw.bill_to.name, 'TARGET CORP C/O CHRLTL'); assert.equal(raw.customer_order_info[0].pallet_slip, 'Y');
    const c = uncreated();
    for (const record of c.records()) { record.loads[0].assignedSCAC = 'SCII'; record.address = record._id; }
    await c.access.prepare(c.device, { barcode });
    assert.equal(c.records()[0].loads[0].bol.rawData.ship_to.address, '2590 Campbell Blvd');
});

test('generation and dual signature saves roll back all merged copies on failure', async () => {
    const t = uncreated(); t.failWrite(2);
    await assert.rejects(t.access.prepare(t.device, { barcode }), /simulated/);
    assert.ok(t.records().every(record => !record.loads[0].bol.rawData));
    const prepared = await t.access.prepare(t.device, { barcode });
    const input = { ...await t.input(prepared.grant), shipperImage: await image };
    t.failWrite(t.writes() + 2);
    await assert.rejects(t.access.sign(t.device, input), /simulated/);
    assert.ok(t.records().every(record => !record.loads[0].bol.rawData.shipper_signature && !record.loads[0].bol.rawData.driver_signature));
    await t.access.sign(t.device, input);
});

test('a document created elsewhere during generation is preserved and ordinary scans stay driver-only', async () => {
    const t = setup(); const before = structuredClone(t.records());
    const prepared = await t.access.prepare(t.device, { barcode });
    assert.equal(prepared.requiresShipper, false); assert.equal(t.writes(), 0); assert.deepEqual(t.records(), before);
    await assert.rejects(t.access.sign(t.device, { ...await t.input(prepared.grant), shipperImage: await image }), /invalidMessage/);
});

test('changed shipment quantities and destinations invalidate generated unsigned BOLs', async () => {
    for (const change of [t => { t.records()[0].loads[0].cartons++; }, t => { t.records()[0].address = 'New address'; }]) {
        const t = uncreated(); const prepared = await t.access.prepare(t.device, { barcode });
        change(t);
        await assert.rejects(t.access.lookup(t.device, barcode, true, true), /bolChanged/);
        await assert.rejects(t.access.sign(t.device, { ...await t.input(prepared.grant), shipperImage: await image }), /bolChanged/);
        assert.equal(t.writes(), 2);
    }
});

test('deleting and regenerating identical shipments invalidates old signing grants', async () => {
    const t = uncreated(); const original = await t.access.prepare(t.device, { barcode });
    const oldId = t.records()[0].loads[0].bol.rawData.signature_pad_document_id;
    await saveBolDraft(t.models.outbound, { loadNumber: 'LOAD-1' }, { 'bol.rawData': null, 'bol.url': null });
    const replacement = await t.access.prepare(t.device, { barcode });
    assert.notEqual(t.records()[0].loads[0].bol.rawData.signature_pad_document_id, oldId);
    await assert.rejects(t.access.sign(t.device, { ...await t.input(original.grant), shipperImage: await image }), /bolChanged/);
    await t.access.sign(t.device, { ...await t.input(replacement.grant), shipperImage: await image });
});

test('a shipper signature added in MES resumes driver signing and cannot be overwritten by an older two-party scan', async () => {
    const t = uncreated(); const original = await t.access.prepare(t.device, { barcode });
    const draft = structuredClone(t.records()[0].loads[0].bol.rawData);
    draft.shipper_signature = 'saved-in-MES'; draft.shipper_signature_date = '2026-09-14T16:00:00Z';
    await saveBolDraft(t.models.outbound, { loadNumber: 'LOAD-1' }, { 'bol.rawData': draft });
    await assert.rejects(t.access.sign(t.device, { ...await t.input(original.grant), shipperImage: await image }), /bolChanged/);
    const found = await t.access.lookup(t.device, barcode, true, true);
    assert.equal(found.requiresShipper, false);
    const input = await t.input(found.grant); await t.access.sign(t.device, input);
    await t.access.authorize(t.user, t.device._id);
    const printed = await t.access.printData(t.user, { grant: found.grant, submissionId: input.submissionId, deviceId: t.device._id });
    assert.equal(printed.bol.shipper_signature, 'saved-in-MES');
});

test('two phones cannot replace each other’s saved signatures, but the winner can retry after completion', async () => {
    const t = uncreated(); const first = await t.access.prepare(t.device, { barcode });
    const other = { _id: 'pad-two' }; const second = await t.access.lookup(other, barcode, true, true);
    const input = { ...await t.input(first.grant), shipperImage: await image };
    const saved = await t.access.sign(t.device, input);
    await assert.rejects(t.access.sign(other, { ...await t.input(second.grant), shipperImage: await image }), /alreadySigned/);
    for (const record of t.records()) record.loads[0].status = 'Completed';
    assert.deepEqual(await t.access.sign(t.device, input), saved);
});

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

test('gate registration fills only blank BOL fields and invalidates earlier signing requests', async () => {
    const t = setup();
    for (const record of t.records()) record.loads[0].bol.rawData.trailer = 'BOL-EDIT';
    const before = await t.lookup();
    t.trucks.push({ loadNumber: 'OTHER', trailer: 'WRONG', seal: 'WRONG', arrivedAt: '2026-09-15' },
        { loadNumber: 'LOAD-1', trailer: 'OLD', seal: 'OLD', arrivedAt: '2026-09-13' },
        { loadNumber: 'LOAD-1', trailer: 'GATE-123', seal: ' SEAL-456 ', arrivedAt: '2026-09-14' },
        { loadNumber: 'LOAD-1', trailer: 'CANCELLED', seal: 'CANCELLED', status: 'Cancelled', arrivedAt: '2026-09-15' });
    const found = await t.lookup();
    assert.equal(found.trailerNumber, 'BOL-EDIT');
    for (const record of t.records()) {
        assert.equal(record.loads[0].bol.rawData.trailer, 'BOL-EDIT');
        assert.equal(record.loads[0].bol.rawData.seal_number, 'SEAL-456');
    }
    await assert.rejects(t.access.sign(t.device, await t.input(before.grant)), /bolChanged/);
    await t.access.sign(t.device, await t.input(found.grant));
    const signed = structuredClone(t.records());
    t.trucks[2].trailer = 'NEW'; t.trucks[2].seal = 'NEW';
    await t.access.lookup(t.device, barcode, true);
    assert.deepEqual(t.records(), signed, 'Signed BOLs are never changed by gate records');
});

test('gate details preserve a manually edited seal and roll back merged BOLs on failure', async () => {
    const t = setup();
    for (const record of t.records()) record.loads[0].bol.rawData.seal_number = 'BOL-SEAL';
    t.trucks.push({ loadNumber: 'LOAD-1', trailer: 'GATE-123', seal: 'GATE-SEAL' });
    const before = structuredClone(t.records());
    t.failWrite(2);
    await assert.rejects(t.lookup(), /simulated write failure/);
    assert.deepEqual(t.records(), before);
    const found = await t.lookup();
    assert.equal(found.trailerNumber, 'GATE-123');
    for (const record of t.records()) assert.equal(record.loads[0].bol.rawData.seal_number, 'BOL-SEAL');
});

test('gate fallback cannot alter a merged BOL with an already signed copy', async () => {
    const t = setup();
    t.records()[1].loads[0].bol.rawData.driver_signature = await image;
    t.trucks.push({ loadNumber: 'LOAD-1', trailer: 'GATE-123', seal: 'SEAL-456' });
    const before = structuredClone(t.records());
    await assert.rejects(t.access.lookup(t.device, barcode, true), /ambiguousBol/);
    assert.deepEqual(t.records(), before);
    assert.equal(t.writes(), 0);
});

test('lookup returns document details and updates only the driver signature on every merged copy', async () => {
    const t = setup();
    assert.equal((await t.lookup()).trailerNumber, '');
    for (const record of t.records()) record.loads[0].bol.rawData.trailer = ' T-123 ';
    const found = await t.lookup();
    assert.equal(found.trailerNumber, 'T-123');
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
        assert.equal(response.status, 200);
        const found = (await response.json()).payload;
        assert.equal(found.bolNumber, number);
        const signingResponse = await fetch(`${url}/bol/sign`, { method: 'POST', headers, body: JSON.stringify(await t.input(found.grant)) });
        assert.equal(signingResponse.status, 200);
        const signedResponse = await fetch(`${url}/bol/lookup`, { method: 'POST', headers, body: JSON.stringify({ barcode, allowSigned: true }) });
        assert.equal(signedResponse.status, 200);
        assert.equal((await signedResponse.json()).payload.signed, true);
        t.records().splice(0, t.records().length, ...uncreated().records());
        const pendingResponse = await fetch(`${url}/bol/lookup`, { method: 'POST', headers, body: JSON.stringify({ barcode, allowSigned: true, allowCreate: true }) });
        assert.equal((await pendingResponse.json()).payload.needsGeneration, true);
        const prepareResponse = await fetch(`${url}/bol/prepare`, { method: 'POST', headers, body: JSON.stringify({ barcode }) });
        assert.equal(prepareResponse.status, 200);
        const prepared = (await prepareResponse.json()).payload;
        assert.equal(prepared.requiresShipper, true);
        const bothResponse = await fetch(`${url}/bol/sign`, { method: 'POST', headers, body: JSON.stringify({ ...await t.input(prepared.grant), shipperImage: await image }) });
        assert.equal(bothResponse.status, 200);
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

test('signed BOL scans issue print-only grants, including historical signatures and completed loads', async () => {
    const t = setup(); await t.access.authorize(t.user, t.device._id);
    for (const record of t.records()) {
        record.loads[0].status = 'Completed';
        Object.assign(record.loads[0].bol.rawData, { driver_signature: await image, driver_signature_date: '2026-09-14' });
    }
    const before = structuredClone(t.records());
    const found = await t.access.lookup(t.device, barcode, true);
    assert.equal(found.signed, true);
    assert.equal(found.bolNumber, number);
    await assert.rejects(t.lookup(), /alreadySigned/, 'Older pads retain their existing behavior');
    await assert.rejects(t.access.sign(t.device, await t.input(found.grant)), /deviceUnauthorized/);
    const request = { grant: found.grant, submissionId: randomUUID(), deviceId: t.device._id };
    const printable = await t.access.printData(t.user, request);
    assert.equal(printable.documentId, found.documentId);
    assert.deepEqual(printable.bol, before[0].loads[0].bol.rawData);
    assert.deepEqual(t.records(), before);
    assert.equal(t.writes(), 0);
    await assert.rejects(t.access.printData(t.user, { ...request, deviceId: 'another-pad' }), /deviceUnauthorized/);
    await assert.rejects(t.access.printData({ ...t.user, status: 'Inactive' }, request), /deviceUnauthorized/);
    for (const record of t.records()) record.loads[0].bol.rawData.driver_signature_date = '2026-09-15';
    await assert.rejects(t.access.printData(t.user, request), /bolChanged/);
    const updated = await t.access.lookup(t.device, barcode, true);
    await t.access.revoke(t.user, t.device._id);
    await assert.rejects(t.access.printData(t.user, { ...request, grant: updated.grant }), /deviceUnauthorized/);
});

test('signed scan printing rejects partially signed copies and does not unlock unsigned completed loads', async () => {
    const t = setup();
    t.records()[0].loads[0].bol.rawData.driver_signature = await image;
    await assert.rejects(t.access.lookup(t.device, barcode, true), /ambiguousBol/);
    t.records()[0].loads[0].bol.rawData.driver_signature = '';
    t.records()[0].loads[0].status = 'Completed';
    await assert.rejects(t.access.lookup(t.device, barcode, true), /bolCompleted/);
    assert.equal(t.writes(), 0);
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
