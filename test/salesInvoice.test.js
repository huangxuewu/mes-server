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
    const mes = { client: 'Target', poNumber: po.po_number, loads: [{ shipmentId: 'SIQ1', loadNumber: 'LOAD1', status: 'Completed' }] };
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
    const flow = createInvoiceFlow({ db: { outbound: { findOne: () => ({ lean: async () => data.mes }) }, salesInvoice: model }, getClient: async () => client,
        getOrderfulMessage: async () => { downloaded++; return structuredClone(data.message); },
        getDropbox: async () => ({ filesUpload: async input => { if (uploadFailure) throw new Error('Offline'); uploads.push(input); } }),
    });
    const input = { poNumber: data.po.po_number, invoiceDate: '2026-09-12', fingerprint: invoiceFingerprint(data.message) };
    return { ...data, flow, input, records, calls, uploads, posts: () => posts, downloaded: () => downloaded,
        setTimeout: value => { timeout = value; }, setUploadFailure: value => { uploadFailure = value; } };
};
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

test('invoice list filters Target orders before pagination and ERP lookup', async () => {
    const chain = { sort: () => chain, skip: () => chain, limit: () => chain, lean: async () => [] };
    const flow = createInvoiceFlow({ db: { outbound: { find: (query, projection) => {
        assert.equal(query.client, 'Target');
        assert.equal(query['loads.status'], 'Completed');
        assert.equal(projection.client, 1);
        return chain;
    } } }, getClient: async () => { throw new Error('No ERP lookup needed'); } });
    assert.deepEqual(await flow.list(), { rows: [], hasMore: false });
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

module.exports = { fixture };
