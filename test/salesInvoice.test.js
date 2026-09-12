const { test } = require('node:test');
const assert = require('node:assert/strict');
const { inspectInvoice, buildInvoice, invoiceFingerprint, amountCents, INVOICE_QUERY, CREATE_INVOICE, REFRESH_INVOICE } = require('../utils/edi/invoice');
const { createInvoiceFlow } = require('../utils/edi/invoiceFlow');
const { readInvoice, createSalesInvoicePdf } = require('../utils/salesInvoicePdf');

const fixture = () => {
    const po = { po_number: '10001234567-0551', vendor_id: '123', department: '62', po_status: 'Open',
        payment_type_code: '01', payment_basis_date_code: '3', payment_terms_net_days: 60,
        destinationCenter: { dc_code: '0551', dc_name: 'Target Distribution Center' },
        items: [{ id: '1', external_id: '062-01-0001', item_bar_code: '012345678901', item_description: 'Cotton bedding set', total_item_qty: 12, item_unit_cost: '10.125' }],
        load_shipments: [{ id: '10', created_at: '2026-09-01', load_shipment_notice_id: 'SIQ1', load: { load_number: 'LOAD1' }, shipment_notice: { shipment_id: 'SIQ1', status: 'Picked Up' } }],
        edi_transaction: [{ id: '100', stream: 'LIVE', sender_isa_id: 'OFDHTGTDMS', receiver_isa_id: '6111470100', transaction_type: '856', business_number: '10', created_at: '2026-09-01', validation_status: 'VALID', delivery_status: 'DELIVERED', acknowledgment_status: 'ACCEPTED',
            document: { json_data: { transactionSets: [{ beginningSegmentForShipNotice: [{ shipmentIdentification: '10', date: '20260901' }], HL_loop: [
                { hierarchicalLevel: [{ hierarchicalLevelCode: 'S' }], referenceInformation: [{ referenceIdentificationQualifier: 'BM', referenceIdentification: '84017970000000001' }], carrierDetailsRoutingSequenceTransitTime: [{ identificationCode: 'SOCS', transportationMethodTypeCode: 'C' }] },
                { hierarchicalLevel: [{ hierarchicalLevelCode: 'O' }], purchaseOrderReference: [{ purchaseOrderNumber: '10001234567-0551' }] },
                { hierarchicalLevel: [{ hierarchicalLevelCode: 'I' }], itemIdentification: [{ productServiceIDQualifier: 'CB', productServiceID: '062010001' }], itemDetailShipment: [{ numberOfUnitsShipped: '12', unitOrBasisForMeasurementCode: 'EA' }] },
            ] }] } } }],
    };
    const mes = { client: 'Target', poNumber: po.po_number,
        items: [{ styleCode: 'BEDDING', upc: '012345678901', quantity: 12, casePack: 6 }],
        loads: [{ shipmentId: 'SIQ1', loadNumber: 'LOAD1', status: 'Completed', checklist: { loaded: { status: true } } }] };
    const message = buildInvoice(po, inspectInvoice(po, mes), '2026-09-12');
    const invoice = { ...po.edi_transaction[0], id: '200', transaction_type: '810', business_number: 'VS100012345670551', document: { json_data: message } };
    return { po, mes, message, invoice };
};

test('builds the verified ERP 810 contract with decimal totals and actual segment count', () => {
    const { po, mes } = fixture();
    const set = buildInvoice(po, inspectInvoice(po, mes), '2026-09-12').transactionSets[0];
    assert.equal(set.totalMonetaryValueSummary[0].amount, '12150');
    assert.equal(set.beginningSegmentForInvoice[0].invoiceNumber, 'VS100012345670551');
    assert.equal(set.carrierDetails[0].referenceIdentification, '84017970000000001');
    assert.equal(set.IT1_loop[0].baselineItemDataInvoice[0].quantityInvoiced, '12');
    assert.equal(set.transactionSetTrailer[0].numberOfIncludedSegments, '13');
    assert.equal(amountCents([{ quantity: 3, unitPrice: '0.335' }]), 101);
    assert.throws(() => amountCents([{ quantity: 1, unitPrice: 'NaN' }]));
});

for (const status of ['OVERDUE', 'NOT_ACKNOWLEDGED', 'REJECTED', 'ACCEPTEDWITHERRORS']) test(`ASN ${status} cannot authorize an invoice`, () => {
    const { po, mes } = fixture();
    po.edi_transaction[0].acknowledgment_status = status;
    assert.equal(inspectInvoice(po, mes).ready, false);
});
test('requires completed MES shipments, exact quantities, account and PO/DC matches', () => {
    const { po, mes } = fixture();
    mes.loads[0].status = 'Loading';
    assert.equal(inspectInvoice(po, mes).ready, false);
    mes.loads[0].status = 'Completed';
    po.items[0].total_item_qty = 13;
    assert.ok(inspectInvoice(po, mes).reasons.includes('quantityMismatch'));
    po.items[0].total_item_qty = 12;
    po.edi_transaction[0].stream = 'TEST';
    assert.equal(inspectInvoice(po, mes).ready, false);
    po.edi_transaction[0].stream = 'LIVE';
    po.edi_transaction[0].document.json_data.transactionSets[0].HL_loop[1].purchaseOrderReference[0].purchaseOrderNumber = 'OTHER';
    assert.equal(inspectInvoice(po, mes).ready, false);
});
test('uses the latest ASN per shipment, without double counting a replaced ASN', () => {
    const { po, mes } = fixture();
    po.edi_transaction.push({ ...structuredClone(po.edi_transaction[0]), id: '101', created_at: '2026-09-02' });
    assert.equal(inspectInvoice(po, mes).ready, true);
    po.edi_transaction[1].acknowledgment_status = 'NOT_ACKNOWLEDGED';
    assert.equal(inspectInvoice(po, mes).ready, false);
});

test('invoice eligibility waits for the ASN recorded on the noticed load, not an older accepted ASN', () => {
    const { po, mes } = fixture();
    mes.loads[0].asn = { transactionId: '101', state: 'pending', final: false };
    assert.equal(inspectInvoice(po, mes).ready, false);
    assert.ok(inspectInvoice(po, mes).reasons.includes('asnNotAccepted'));
    po.edi_transaction.push({ ...structuredClone(po.edi_transaction[0]), id: '101', created_at: '2026-09-02' });
    assert.equal(inspectInvoice(po, mes).ready, true);
});
test('PO cancellation deadline is not mistaken for a cancelled order', () => {
    const { po, mes } = fixture();
    po.canceled_date = '2026-09-08';
    assert.equal(inspectInvoice(po, mes).ready, true);
    po.po_status = 'Cancelled';
    assert.equal(inspectInvoice(po, mes).ready, false);
});
test('rejects invalid dates and refuses an existing invoice even if rejected', () => {
    const { po, mes, invoice } = fixture();
    assert.throws(() => buildInvoice(po, inspectInvoice(po, mes), '2026-02-30'));
    po.edi_transaction.push({ ...invoice, acknowledgment_status: 'REJECTED' });
    assert.equal(inspectInvoice(po, mes).ready, false);
});
test('PDF data is matched to the full PO, invoice number, type and account', () => {
    const { po, invoice } = fixture();
    const result = readInvoice(invoice, po.po_number);
    assert.equal(result.totalCents, 12150);
    assert.equal(result.items[0].unitPrice, '10.125');
    assert.throws(() => readInvoice(invoice, 'OTHER'));
    assert.throws(() => readInvoice({ ...invoice, sender_isa_id: 'ANOTHER' }, po.po_number));
    assert.throws(() => readInvoice({ ...invoice, business_number: 'WRONG' }, po.po_number));
    invoice.document.json_data.transactionSets[0].totalMonetaryValueSummary[0].amount = '12200';
    assert.equal(readInvoice(invoice, po.po_number).adjustmentCents, 50);
});

const flowFixture = () => {
    const data = fixture();
    const records = [];
    const calls = [];
    let posts = 0;
    let timeout = false;
    let downloaded = 0;
    let uploadFailure = false;
    const matches = (record, query) => Object.entries(query).every(([key, value]) => value === null ? record[key] == null : record[key] === value);
    const model = {
        init: async () => {},
        findOne: query => ({ lean: async () => records.find(record => matches(record, query)) }),
        updateOne: async (key, update) => {
            let record = records.find(record => matches(record, key));
            if (!record) { record = { ...key, ...update.$setOnInsert }; records.push(record); }
            Object.assign(record, update.$set);
        },
        findOneAndUpdate: async (query, update) => {
            const record = records.find(record => matches(record, query));
            if (!record) return null;
            Object.assign(record, update.$set);
            return record;
        },
    };
    const client = { config: { baseUrl: 'https://erp.example', webBaseUrl: 'https://erp.example' }, headers: {}, graphql: async (query, variables) => {
        calls.push({ query, variables });
        if (query === INVOICE_QUERY) return { po: { edges: [{ node: structuredClone(data.po) }], pageInfo: { hasNextPage: false } } };
        if (query === REFRESH_INVOICE) return { refreshTransaction: structuredClone(data.po.edi_transaction.find(transaction => Number(transaction.id) === variables.id)) };
        if (query === CREATE_INVOICE) { posts++; if (timeout) throw new Error('ERP timeout'); data.po.edi_transaction.push(structuredClone(data.invoice)); return { createTransaction: { id: '200' } }; }
        return { ediAccounts: { edges: [{ node: { isa_id: 'OFDHTGTDMS' } }] } };
    } };
    const uploads = [];
    const checklistUpdates = [];
    const flow = createInvoiceFlow({ db: { outbound: { findOne: () => ({ lean: async () => data.mes }),
        updateOne: async (query, update, options) => {
            assert.equal(query.poNumber, data.mes.poNumber);
            assert.equal(query.client, 'Target');
            checklistUpdates.push({ update, options });
            const target = options.arrayFilters[0];
            for (const load of data.mes.loads.filter(load => load.status === 'Completed' && Object.hasOwn(load.checklist || {}, 'noticed'))) {
                const invoice = load.checklist.invoiced;
                const id = target['target.checklist.invoiced.transactionId'];
                if (id.$ne) {
                    if (invoice?.transactionId !== id.$ne) load.checklist.invoiced = structuredClone(update.$set['loads.$[target].checklist.invoiced']);
                } else if (invoice?.transactionId === id && !invoice.acceptedAt) {
                    invoice.acceptedAt = update.$set['loads.$[target].checklist.invoiced.acceptedAt'];
                }
            }
        } }, salesInvoice: model }, getClient: async () => client,
        getOrderfulMessage: async () => { downloaded++; return structuredClone(data.message); },
        getDropbox: async () => ({ filesUpload: async input => { if (uploadFailure) throw new Error('Offline'); uploads.push(input); } }),
    });
    const input = { poNumber: data.po.po_number, invoiceDate: '2026-09-12', fingerprint: invoiceFingerprint(data.message) };
    return { ...data, flow, input, records, calls, uploads, checklistUpdates, posts: () => posts, downloaded: () => downloaded,
        setTimeout: value => { timeout = value; }, setUploadFailure: value => { uploadFailure = value; } };
};
test('ERP review exposes source defaults without changing the submission fingerprint or writing data', async () => {
    const state = flowFixture();
    state.po.destinationCenter.port_code = '90210';
    state.po.load_shipments[0].shipment_tracking = { asn_sent_at: '2026-09-12T02:00:00Z' };
    state.po.load_shipments[0].shipment_notice.assigned_scac = 'SCII';
    const result = await state.flow.get(state.input);
    assert.equal(result.erpSource.destinationCenter.port_code, '90210');
    assert.equal(result.erpSource.load_shipments[0].shipment_notice.assigned_scac, 'SCII');
    assert.equal(result.erpSource.vendor_id, state.po.vendor_id);
    assert.equal(result.erpSource.payment_terms_net_days, 60);
    assert.match(result.erpSource.invoiceDate, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(result.preview.totalCents, 12150);
    assert.equal(result.preview.items[0].lineTotalCents, 12150);
    assert.equal(result.fingerprint, state.input.fingerprint);
    assert.equal(result.erpSource.edi_transaction, undefined);
    assert.equal(state.posts(), 0);
    assert.equal(state.records.length, 0);
    assert.equal(state.downloaded(), 0);
    assert.equal(state.calls.length, 1);
    assert.equal(state.calls[0].query, INVOICE_QUERY);
});

test('concurrent submissions claim the PO once; a later retry reuses the ERP invoice', async () => {
    const state = flowFixture();
    await Promise.allSettled([state.flow.submit(state.input, 'user1'), state.flow.submit(state.input, 'user2')]);
    assert.equal(state.posts(), 1);
    await state.flow.submit(state.input, 'user1');
    assert.equal(state.posts(), 1);
});

test('non-Target and unidentified orders cannot use invoice actions, even with Target transaction data', async () => {
    for (const client of ['Walmart', '', undefined]) {
        const state = flowFixture();
        state.mes.client = client;
        assert.throws(() => inspectInvoice(state.po, state.mes), /Target orders only/);
        for (const action of ['get', 'refresh', 'submit', 'savePdf', 'download'])
            await assert.rejects(state.flow[action](state.input), /Target orders only/);
        assert.equal(state.calls.length, 0);
        assert.equal(state.posts(), 0);
        assert.equal(state.downloaded(), 0);
        assert.equal(state.uploads.length, 0);
    }
});

test('invoice list filters completed Target orders with a noticed field before ERP lookup', async () => {
    const chain = { sort: () => chain, lean: async () => [] };
    const flow = createInvoiceFlow({ db: { outbound: { find: (query, projection) => {
        assert.equal(query.client, 'Target');
        assert.deepEqual(query.loads, { $elemMatch: { status: 'Completed', 'checklist.noticed': { $exists: true } } });
        assert.deepEqual(query.$or[0].poNumber.$in, ['PENDING']);
        assert.deepEqual(query.$or[1].poNumber.$nin, ['PENDING', 'FINISHED']);
        assert.deepEqual(query.$or[1].loads.$not.$elemMatch, { status: { $nin: ['Completed', 'Cancelled', 'Canceled'] } });
        assert.equal(projection.client, 1);
        return chain;
    } }, salesInvoice: { find: (_query, projection) => {
        assert.equal(projection.transactionJson, undefined);
        assert.equal(projection.submittedMessage, undefined);
        return { lean: async () => [
            { poNumber: 'PENDING', transactionId: '10', acknowledgmentStatus: 'NOT_ACKNOWLEDGED' },
            { poNumber: 'FINISHED', transactionId: '11', acknowledgmentStatus: 'ACCEPTED' },
        ] };
    } } }, getClient: async () => ({ config: { baseUrl: 'https://erp.example' }, headers: {},
        graphql: async () => { throw new Error('No ERP lookup needed'); } }) });
    assert.deepEqual(await flow.list(), { rows: [] });
});
test('a durable claim prevents repeating an unknown submission outcome', async () => {
    const state = flowFixture();
    state.setTimeout(true);
    await assert.rejects(state.flow.submit(state.input, 'user'), /timeout/);
    await assert.rejects(state.flow.submit(state.input, 'user'), /submissionUnknown/);
    assert.equal(state.posts(), 1);
    assert.ok(state.records[0].submissionStartedAt);
});
test('changed preview and revoked permission prevent the ERP POST', async () => {
    const state = flowFixture();
    await assert.rejects(state.flow.submit({ ...state.input, fingerprint: 'old' }, 'user'), /changed/);
    await assert.rejects(state.flow.submit(state.input, 'user', async () => { throw new Error('Access revoked'); }), /revoked/);
    assert.equal(state.posts(), 0);
});
test('downloads JSON from Orderful even when ERP already supplies a document', async () => {
    const state = flowFixture();
    state.po.edi_transaction.push(state.invoice);
    const before = await state.flow.get(state.input);
    assert.equal(before.json, null);
    const after = await state.flow.refresh(state.input);
    assert.equal(state.downloaded(), 1);
    assert.deepEqual(after.json, state.message);
    assert.equal(after.canSavePdf, true);
    assert.equal(after.preview.items[0].lineTotalCents, 12150);
});

test('invoice checklist records submission separately and preserves the first acceptance confirmation', async () => {
    const state = flowFixture();
    state.mes.loads[0].checklist = { noticed: { status: true } };
    state.mes.loads.push({ loadNumber: 'LEGACY', status: 'Completed' },
        { loadNumber: 'CANCELLED', status: 'Cancelled', checklist: { noticed: { status: true } } });
    // Existing ERP invoice reconciliation does not require another submission.
    state.invoice.acknowledgment_status = 'NOT_ACKNOWLEDGED';
    state.invoice.created_at = '2026-09-12T12:00:00Z';
    state.po.edi_transaction.push(state.invoice);
    await state.flow.refresh(state.input);
    const submitted = state.mes.loads[0].checklist.invoiced;
    assert.deepEqual(submitted, { status: true, timestamp: state.invoice.created_at, transactionId: '200', acceptedAt: null });
    assert.equal(state.mes.loads[1].checklist, undefined);
    assert.equal(state.mes.loads[2].checklist.invoiced, undefined);
    state.invoice.acknowledgment_status = 'ACCEPTED';
    await state.flow.refresh(state.input);
    const acceptedAt = +state.mes.loads[0].checklist.invoiced.acceptedAt;
    assert.ok(acceptedAt > +new Date(state.invoice.created_at));
    await state.flow.refresh(state.input);
    assert.equal(+state.mes.loads[0].checklist.invoiced.acceptedAt, acceptedAt);
    assert.equal(state.mes.loads[0].checklist.invoiced.timestamp, state.invoice.created_at);
    state.mes.loads.splice(1);
    assert.equal((await state.flow.get(state.input)).timeline.invoiceAcceptedAt, new Date(acceptedAt).toISOString());
    state.mes.loads[0].checklist.invoiced.transactionId = 'OLD';
    assert.equal((await state.flow.get(state.input)).timeline.invoiceAcceptedAt, null);
    assert.equal(state.posts(), 0);
});

test('a completed load with only part of the PO cannot submit even with an accepted ASN', async () => {
    const state = flowFixture();
    state.mes.loads[0].items = [{ ...state.mes.items[0], quantity: 6 }];
    assert.equal(state.po.edi_transaction[0].acknowledgment_status, 'ACCEPTED');
    const detail = await state.flow.get(state.input);
    assert.equal(detail.timeline.shipped, false);
    assert.equal(detail.ready, false);
    await assert.rejects(state.flow.submit(state.input, 'user'), /shipmentIncomplete/);
    assert.equal(state.posts(), 0);
});

test('Shipped compares every PO item against quantities on loaded, non-cancelled loads', async () => {
    const state = flowFixture();
    const { mes } = state;
    mes.items.push({ styleCode: 'PILLOW', quantity: 4, casePack: 2 });
    mes.loads[0].items = [{ ...mes.items[0], quantity: 6 }, { ...mes.items[1], quantity: 4 }];
    mes.loads.push({ shipmentId: 'SIQ2', loadNumber: 'LOAD2', status: 'Loading',
        items: [{ ...mes.items[0], quantity: 6 }], checklist: { loaded: { status: false } } });
    assert.equal((await state.flow.get(state.input)).timeline.shipped, false);
    mes.loads[1].checklist.loaded.status = true;
    assert.equal((await state.flow.get(state.input)).timeline.shipped, true);
    mes.loads[1].items[0].quantity = 7;
    assert.equal((await state.flow.get(state.input)).timeline.shipped, false, 'overloading is a mismatch');
    mes.loads[1].items[0] = { styleCode: 'WRONG', quantity: 6 };
    assert.equal((await state.flow.get(state.input)).timeline.shipped, false, 'same total with wrong item is a mismatch');
    mes.loads[1].items = [{ ...mes.items[0], quantity: 6 }];
    mes.loads[1].status = 'Cancelled';
    assert.equal((await state.flow.get(state.input)).timeline.shipped, false);
    mes.loads[0].items = structuredClone(mes.items);
    assert.equal((await state.flow.get(state.input)).timeline.shipped, true, 'cancelled quantities do not count');
    mes.loads[0].checklist.loaded.status = false;
    assert.equal((await state.flow.get(state.input)).timeline.shipped, false, 'Completed alone is not proof of loading');
    mes.loads[0].checklist.loaded.status = true;
    mes.loads[0].items = [];
    assert.equal((await state.flow.get(state.input)).timeline.shipped, false, 'empty allocation does not inherit PO items');
    delete mes.loads[0].items;
    assert.equal((await state.flow.get(state.input)).timeline.shipped, true, 'unallocated loads follow MES item inheritance');
    delete mes.items;
    assert.equal((await state.flow.get(state.input)).timeline.shipped, false, 'missing PO quantities cannot confirm loading');
});
test('Dropbox failure retries only PDF storage and uses invoice year / PO / full PO.pdf', async () => {
    const state = flowFixture();
    await state.flow.submit(state.input, 'user');
    await state.flow.refresh(state.input);
    state.setUploadFailure(true);
    await assert.rejects(state.flow.savePdf(state.input), /Dropbox upload failed/);
    state.setUploadFailure(false);
    const result = await state.flow.savePdf(state.input);
    assert.equal(result.pdfPath, '/DH MES/Sales Invoices/2026/10001234567-0551/10001234567-0551.pdf');
    assert.equal(state.posts(), 1);
    assert.equal(state.uploads[0].autorename, false);
    assert.equal(state.uploads[0].mode['.tag'], 'add');
    await state.flow.savePdf(state.input);
    assert.equal(state.uploads.length, 1);
});
test('renders repeatable PDF bytes for safe conflict recovery', async () => {
    const { invoice, po } = fixture();
    const data = readInvoice(invoice, po.po_number);
    const a = await createSalesInvoicePdf(data);
    const b = await createSalesInvoicePdf(data);
    assert.equal(a.subarray(0, 4).toString(), '%PDF');
    assert.ok(a.equals(b));
});

test('an eight-line invoice fits one page without footer-created blank pages', async () => {
    const { invoice, po } = fixture();
    const data = readInvoice(invoice, po.po_number);
    data.items = Array.from({ length: 8 }, (_, index) => ({ ...data.items[0], description: '', line: String(index + 1) }));
    data.subtotalCents = amountCents(data.items);
    data.totalCents = data.subtotalCents;
    const pdf = await createSalesInvoicePdf(data);
    assert.equal((pdf.toString('latin1').match(/\/Type \/Page\b/g) || []).length, 1);
});

test('invoice queue includes ready orders and unresolved submissions, and excludes other history', async () => {
    for (const scenario of ['ready', 'asnPending', 'quantityMismatch', 'pendingInvoice', 'savedPendingInvoice', 'accepted', 'rejected', 'invalid', 'failed', 'unknownSubmission']) {
        const { po, mes, invoice } = fixture();
        mes.loads[0].checklist.noticed = { status: true };
        const record = { poNumber: po.po_number };
        if (scenario === 'asnPending') po.edi_transaction[0].acknowledgment_status = 'NOT_ACKNOWLEDGED';
        if (scenario === 'quantityMismatch') po.items[0].total_item_qty = 13;
        if (scenario === 'unknownSubmission') record.submissionStartedAt = new Date();
        if (['pendingInvoice', 'savedPendingInvoice', 'accepted', 'rejected', 'invalid', 'failed'].includes(scenario)) {
            invoice.acknowledgment_status = scenario === 'accepted' ? 'ACCEPTED' : scenario === 'rejected' ? 'REJECTED' : 'NOT_ACKNOWLEDGED';
            if (scenario === 'invalid') invoice.validation_status = 'INVALID';
            if (scenario === 'failed') invoice.delivery_status = 'FAILED';
            po.edi_transaction.push(invoice);
            record.transactionId = invoice.id;
            // The live ERP result must override an older pending status in MES.
            record.acknowledgmentStatus = 'NOT_ACKNOWLEDGED';
            if (scenario === 'savedPendingInvoice') record.pdfPath = '/invoice.pdf';
        }
        const chain = { sort: () => chain, lean: async () => [mes] };
        const flow = createInvoiceFlow({
            db: { outbound: { find: () => chain, findOne: () => ({ lean: async () => mes }) },
                salesInvoice: { find: () => ({ lean: async () => [record] }), findOne: () => ({ lean: async () => record }) } },
            getClient: async () => ({ config: { baseUrl: 'https://erp.example', webBaseUrl: 'https://erp.example' }, headers: {},
                graphql: async () => ({ po: { edges: [{ node: po }], pageInfo: { hasNextPage: false } } }) }),
        });
        const expected = ['ready', 'pendingInvoice', 'savedPendingInvoice', 'unknownSubmission'].includes(scenario);
        assert.equal((await flow.list()).rows.length, Number(expected), scenario);
        assert.equal((await flow.get({ poNumber: po.po_number, invoiceDate: '2026-09-12' })).inQueue, expected, scenario);
    }
});

test('timeline separates loaded, ASN acceptance, invoice submission and acceptance times', async () => {
    const { po, mes, invoice } = fixture();
    mes.loads[0].actualPickupAt = '2026-09-01T14:00:00Z';
    mes.loads[0].checklist = { loaded: { status: true, timestamp: '2026-09-01T13:00:00Z' }, noticed: { status: true, timestamp: '2026-09-01T14:15:00Z' } };
    mes.loads[0].asn = { transactionId: '100', state: 'accepted', final: true, checkedAt: '2026-09-02T18:00:00Z' };
    mes.loads[0].items = [{ ...mes.items[0], quantity: 6 }];
    mes.loads.push({ ...structuredClone(mes.loads[0]), loadNumber: 'LOAD2', actualPickupAt: '2026-09-01T15:00:00Z' });
    mes.loads[1].checklist.loaded.timestamp = '2026-09-01T13:30:00Z';
    mes.loads[1].asn.transactionId = '101';
    mes.loads[1].asn.checkedAt = '2026-09-02T19:00:00Z';
    po.load_shipments.push({ ...structuredClone(po.load_shipments[0]), id: '11', load: { load_number: 'LOAD2' } });
    po.edi_transaction.push({ ...structuredClone(po.edi_transaction[0]), id: '101', business_number: '11' });
    const chain = { sort: () => chain, lean: async () => [mes] };
    const record = { poNumber: po.po_number, submissionStartedAt: '2026-09-03T10:00:00Z', transactionId: '200' };
    invoice.created_at = '2026-09-03T10:01:00Z';
    invoice.acknowledgment_status = 'NOT_ACKNOWLEDGED';
    po.edi_transaction.push(invoice);
    const flow = createInvoiceFlow({
        db: { outbound: { find: () => chain, findOne: () => ({ lean: async () => mes }) },
            salesInvoice: { find: () => ({ lean: async () => [record] }), findOne: () => ({ lean: async () => record }) } },
        getClient: async () => ({ config: { baseUrl: 'https://erp.example', webBaseUrl: 'https://erp.example' }, headers: {},
            graphql: async () => ({ po: { edges: [{ node: po }], pageInfo: { hasNextPage: false } } }) }),
    });
    const expected = { shipped: true, shippedAt: '2026-09-01T13:30:00.000Z', shippedLoadNumber: 'LOAD2', asnSubmitted: true, asnSubmittedAt: '2026-09-01T14:15:00.000Z',
        asnSubmittedLoadNumber: 'LOAD1', asnAcceptedLoadNumber: 'LOAD2',
        asnAt: '2026-09-02T19:00:00.000Z', invoicedAt: invoice.created_at, invoiceAcceptedAt: null };
    assert.deepEqual((await flow.list()).rows[0].timeline, expected);
    assert.deepEqual((await flow.get({ poNumber: po.po_number })).timeline, expected);
    delete mes.loads[1].checklist.loaded.timestamp;
    mes.loads[1].asn.transactionId = 'STALE';
    const missingTime = (await flow.get({ poNumber: po.po_number })).timeline;
    assert.equal(missingTime.shippedAt, '2026-09-01T13:00:00.000Z');
    assert.equal(missingTime.shippedLoadNumber, 'LOAD1');
    assert.equal(missingTime.asnAt, null);
    assert.equal(missingTime.asnAcceptedLoadNumber, null);
    assert.equal(missingTime.asnSubmittedLoadNumber, 'LOAD1');
    assert.equal(missingTime.asnSubmittedAt, expected.asnSubmittedAt);
    delete mes.loads[0].checklist.noticed.timestamp;
    delete mes.loads[1].checklist.noticed.timestamp;
    assert.equal((await flow.get({ poNumber: po.po_number })).timeline.asnSubmittedAt, null);
    mes.loads[1].asn.transactionId = '101';
    po.edi_transaction[1].acknowledgment_status = 'NOT_ACKNOWLEDGED';
    assert.equal((await flow.get({ poNumber: po.po_number })).timeline.asnAt, null);
    mes.loads.splice(1);
    delete mes.loads[0].checklist.loaded.timestamp;
    const untimedLoad = (await flow.get({ poNumber: po.po_number })).timeline;
    assert.equal(untimedLoad.shippedAt, null);
    assert.equal(untimedLoad.shippedLoadNumber, 'LOAD1');
});

module.exports = { fixture };


test('invoice list returns every available row beyond the former 25-row limit', async () => {
    const documents = Array.from({ length: 31 }, (_, index) => ({ poNumber: `PO${index}`, client: 'Target', loads: [{ loadNumber: `LOAD${index}`, status: 'Completed', checklist: { noticed: { status: false } } }] }));
    const chain = { sort: () => chain, lean: async () => documents };
    const flow = createInvoiceFlow({
        db: { outbound: { find: () => chain }, salesInvoice: { find: () => ({ lean: async () => documents.map(document => ({ poNumber: document.poNumber, submissionStartedAt: new Date() })) }) } },
        getClient: async () => ({ config: { baseUrl: 'https://erp.example' }, headers: {},
            graphql: async () => ({ po: { edges: [], pageInfo: { hasNextPage: false } } }) }),
    });
    const result = await flow.list();
    assert.equal(result.rows.length, 31);
    assert.equal(result.rows[30].poNumber, 'PO30');
    assert.deepEqual(result.rows[30].loadNumbers, ['LOAD30']);
});

test('invoice rows retain PO-specific BOL links, including when ERP matching fails', async () => {
    const { po, mes } = fixture();
    mes.loads[0].bol = { url: 'https://files.example/load1.pdf' };
    mes.loads[0].checklist = { noticed: { status: false } };
    mes.loads.push({ loadNumber: 'LOAD1', status: 'Completed' }, { loadNumber: 'LOAD2', status: 'Completed' });
    const missing = { client: 'Target', poNumber: 'OTHER', loads: [{ loadNumber: 'LOAD1', status: 'Completed', checklist: { noticed: { status: true } }, bol: { url: 'https://files.example/other.pdf' } }] };
    for (const document of [mes, missing]) document.loads.push(
        { loadNumber: 'LEGACY', status: 'Completed', bol: { url: 'https://files.example/legacy.pdf' } },
        { loadNumber: 'PENDING', status: 'Loading', checklist: { noticed: { status: true } }, bol: { url: 'https://files.example/pending.pdf' } },
        { loadNumber: 'CANCELLED', status: 'Cancelled', checklist: { noticed: { status: false } } },
    );
    const chain = { sort: () => chain, lean: async () => [mes, missing] };
    const flow = createInvoiceFlow({
        db: { outbound: { find: () => chain, findOne: () => ({ lean: async () => mes }) },
            salesInvoice: { find: () => ({ lean: async () => [mes, missing].map(document => ({ poNumber: document.poNumber, submissionStartedAt: new Date() })) }), findOne: () => ({ lean: async () => null }) } },
        getClient: async () => ({ config: { baseUrl: 'https://erp.example', webBaseUrl: 'https://erp.example' }, headers: {},
            graphql: async () => ({ po: { edges: [{ node: po }], pageInfo: { hasNextPage: false } } }) }),
    });
    const { rows } = await flow.list();
    assert.deepEqual(rows.map(row => row.loadNumbers), [['LOAD1'], ['LOAD1']]);
    assert.deepEqual(rows[0].bolUrls, { LOAD1: 'https://files.example/load1.pdf' });
    assert.deepEqual(rows[1].bolUrls, { LOAD1: 'https://files.example/other.pdf' });
    assert.ok(rows[1].error);
    assert.equal((await flow.get({ poNumber: po.po_number })).bolUrls.LOAD1, rows[0].bolUrls.LOAD1);
});
