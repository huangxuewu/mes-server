const { createHash } = require('node:crypto');
const { REFRESH_INVOICE, CREATE_INVOICE, domestic, inspectInvoice, buildInvoice, invoiceFingerprint, readPurchaseOrders, amountCents } = require('./invoice');
const { readInvoice, createSalesInvoicePdf } = require('../salesInvoicePdf');

const createInvoiceFlow = ({ db, getClient, getDropbox, getOrderfulMessage }) => {
    const context = async poNumber => {
        if (typeof poNumber !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(poNumber)) throw new Error('A valid full PO number is required');
        const client = await getClient();
        const integrationKey = createHash('sha256').update(`${client.config.baseUrl}:${client.headers['x-tenant-id'] || ''}:OFDHTGTDMS`).digest('hex');
        const key = { integrationKey, poNumber };
        const mes = await db.outbound.findOne({ poNumber }).lean();
        if (!mes) throw new Error('MES shipment was not found');
        if (mes.client !== 'Target') throw new Error('Sales invoices currently support Target orders only');
        const orders = await readPurchaseOrders(client, [poNumber]);
        if (orders.length !== 1) throw new Error('ERP purchase order was not found uniquely');
        const record = await db.salesInvoice.findOne(key).lean() || {};
        return { client, key, mes, po: orders[0], record };
    };
    const present = ({ client, po, mes, record }, invoiceDate) => {
        const state = inspectInvoice(po, mes, record);
        const json = state.transactionId === record.transactionId ? record.transactionJson : null;
        const invoice = json && state.invoice ? readInvoice({ ...state.invoice, document: { json_data: json } }, po.po_number) : null;
        const message = state.ready ? buildInvoice(po, state, invoiceDate) : null;
        const preview = invoice || (state.transactionId ? null : { poNumber: state.poNumber, invoiceNumber: state.invoiceNumber,
            totalCents: state.totalCents, items: state.items, buyer: state.buyer, invoiceDate });
        if (preview) preview.items = preview.items.map(item => ({ ...item, lineTotalCents: amountCents([item]) }));
        return { ...state, invoice: state.invoice ? { id: state.invoice.id, validation: state.invoice.validation_status,
            delivery: state.invoice.delivery_status, acknowledgment: state.invoice.acknowledgment_status } : null,
            preview, json,
            invoiceDate, fingerprint: message ? invoiceFingerprint(message) : '',
            erpUrl: `${client.config.webBaseUrl.replace(/\/$/, '')}/shipping/invoice/${state.transactionId ? 'detail' : 'send'}/${encodeURIComponent(po.po_number)}`,
            orderfulUrl: state.transactionId ? `https://ui.orderful.com/transactions/${encodeURIComponent(state.transactionId)}` : '',
            canSavePdf: !!invoice && state.invoice?.validation_status === 'VALID'
                && state.invoice?.delivery_status !== 'FAILED' && !['REJECTED', 'ACCEPTEDWITHERRORS'].includes(state.invoice?.acknowledgment_status),
        };
    };
    const get = async ({ poNumber, invoiceDate }) => present(await context(poNumber), invoiceDate);

    const list = async ({ search = '', page = 0 } = {}) => {
        if (typeof search !== 'string' || search.length > 80 || !Number.isSafeInteger(page) || page < 0) throw new Error('Invalid invoice search');
        const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const query = { client: 'Target', 'loads.status': 'Completed', ...(search ? { poNumber: { $regex: escaped, $options: 'i' } } : {}) };
        const documents = await db.outbound.find(query, { poNumber: 1, client: 1, loads: 1 }).sort({ updatedAt: -1, _id: 1 }).skip(page * 25).limit(26).lean();
        const selected = documents.slice(0, 25);
        if (!selected.length) return { rows: [], hasMore: false };
        const client = await getClient();
        const integrationKey = createHash('sha256').update(`${client.config.baseUrl}:${client.headers['x-tenant-id'] || ''}:OFDHTGTDMS`).digest('hex');
        const numbers = selected.map(mes => mes.poNumber);
        const orders = await readPurchaseOrders(client, numbers);
        const records = await db.salesInvoice.find({ integrationKey, poNumber: { $in: numbers } }).lean();
        const rows = selected.map(mes => {
            try {
                const matches = orders.filter(po => po.po_number === mes.poNumber);
                if (matches.length !== 1) throw new Error('ERP purchase order was not found uniquely');
                const state = inspectInvoice(matches[0], mes, records.find(record => record.poNumber === mes.poNumber));
                return { poNumber: state.poNumber, invoiceNumber: state.invoiceNumber, totalCents: state.totalCents, ready: state.ready,
                    asnAccepted: state.asnAccepted, reasons: state.reasons, pdfPath: state.pdfPath, transactionId: state.transactionId,
                    acknowledgment: state.invoice?.acknowledgment_status || '', loadNumbers: state.loadNumbers };
            } catch (error) { return { poNumber: mes.poNumber, ready: false, error: error.message }; }
        });
        return { rows, hasMore: documents.length > 25 };
    };

    const submit = async ({ poNumber, invoiceDate, fingerprint }, actor, authorize = async () => {}) => {
        await db.salesInvoice.init();
        const ctx = await context(poNumber);
        let state = inspectInvoice(ctx.po, ctx.mes, ctx.record);
        if (state.transactionId) return { transactionId: state.transactionId, existing: true };
        if (!state.ready) throw new Error(`Invoice is not ready: ${state.reasons.join(', ')}`);
        // Refresh partner acknowledgments before the final server-side eligibility check.
        for (const asn of state.asns) await ctx.client.graphql(REFRESH_INVOICE, { id: Number(asn.transactionId) });
        const freshOrders = await readPurchaseOrders(ctx.client, [poNumber]);
        if (freshOrders.length !== 1) throw new Error('ERP PO changed. Refresh the invoice preview.');
        ctx.po = freshOrders[0];
        ctx.mes = await db.outbound.findOne({ poNumber }).lean();
        state = inspectInvoice(ctx.po, ctx.mes, ctx.record);
        if (state.transactionId) return { transactionId: state.transactionId, existing: true };
        const message = buildInvoice(ctx.po, state, invoiceDate);
        if (!fingerprint || fingerprint !== invoiceFingerprint(message)) throw new Error('Invoice data changed. Refresh and review the preview before submitting.');
        const accounts = await ctx.client.graphql(`query MesInvoiceAccount($filter: EdiAccountFilter) {
            ediAccounts(first: 2, filter: $filter) { edges { node { isa_id } } }
        }`, { filter: { vendor_id: { eq: ctx.po.vendor_id } } });
        const rows = accounts?.ediAccounts?.edges || [];
        if (rows.length !== 1 || rows[0].node.isa_id !== 'OFDHTGTDMS') throw new Error('The PO does not belong to the configured Target domestic account');
        await authorize();
        try {
            await db.salesInvoice.updateOne(ctx.key, { $setOnInsert: { ...ctx.key } }, { upsert: true });
        } catch (error) { if (error.code !== 11000) throw error; }
        const claimed = await db.salesInvoice.findOneAndUpdate({ ...ctx.key, submissionStartedAt: null, transactionId: null }, {
            $set: { submissionStartedAt: new Date(), submittedBy: String(actor), submittedMessage: message, invoiceNumber: state.invoiceNumber, invoiceDate },
        }, { new: true });
        if (!claimed) throw new Error('An invoice submission already exists. Refresh its status; do not send again.');
        // Keep the durable claim even when ERP times out. A later refresh reconciles the result.
        const result = await ctx.client.graphql(CREATE_INVOICE, { input: { account_code: 'Domestic', stream: 'LIVE', type: 'INVOICE_810', message } });
        const transactionId = result?.createTransaction?.id;
        if (!transactionId) throw new Error('ERP returned no transaction ID. Refresh or review ERP before retrying.');
        await db.salesInvoice.updateOne(ctx.key, { $set: { transactionId: String(transactionId) } });
        return { transactionId: String(transactionId) };
    };

    const refresh = async (input, authorize = async () => {}) => {
        const ctx = await context(input.poNumber);
        const state = inspectInvoice(ctx.po, ctx.mes, ctx.record);
        const ids = [...new Set([...state.asns.map(asn => asn.transactionId), state.transactionId].filter(Boolean))];
        for (const id of ids) {
            const data = await ctx.client.graphql(REFRESH_INVOICE, { id: Number(id) });
            const transaction = data?.refreshTransaction;
            if (!transaction || String(transaction.id) !== String(id) || !domestic(transaction)) throw new Error('ERP transaction refresh did not match the requested account');
            const index = ctx.po.edi_transaction.findIndex(value => value.id === transaction.id);
            index < 0 ? ctx.po.edi_transaction.push(transaction) : ctx.po.edi_transaction.splice(index, 1, transaction);
        }
        const current = inspectInvoice(ctx.po, ctx.mes, ctx.record);
        if (current.invoice) {
            const json = await getOrderfulMessage(current.invoice.id);
            if (json) readInvoice({ ...current.invoice, document: { json_data: json } }, input.poNumber);
            await authorize();
            const update = { transactionId: current.invoice.id, invoiceNumber: current.invoice.business_number,
                validationStatus: current.invoice.validation_status, deliveryStatus: current.invoice.delivery_status,
                acknowledgmentStatus: current.invoice.acknowledgment_status, ...(json ? { transactionJson: json } : {}) };
            await db.salesInvoice.updateOne(ctx.key, { $set: update, $setOnInsert: ctx.key }, { upsert: true });
            ctx.record = { ...ctx.record, ...update };
            if (json) current.invoice.document = { json_data: json };
        }
        return present(ctx, input.invoiceDate);
    };

    const savePdf = async (input, authorize = async () => {}) => {
        const ctx = await context(input.poNumber);
        const state = present(ctx, input.invoiceDate);
        if (!state.canSavePdf) throw new Error('Refresh the invoice to retrieve valid Orderful JSON before saving its PDF');
        const invoice = readInvoice({ ...inspectInvoice(ctx.po, ctx.mes, ctx.record).invoice, document: { json_data: state.json } }, input.poNumber);
        const hash = invoiceFingerprint(state.json);
        const path = `/DH MES/Sales Invoices/${invoice.year}/${invoice.poNumber}/${invoice.poNumber}.pdf`;
        if (ctx.record.pdfPath && ctx.record.pdfSourceHash !== hash) throw new Error('The saved invoice JSON has changed. Review the existing PDF before replacing it.');
        const dropbox = await getDropbox();
        if (!dropbox) throw new Error('Configure the MES Dropbox integration before saving invoices');
        if (!ctx.record.pdfPath) {
            const contents = await createSalesInvoicePdf(invoice);
            await authorize();
            try {
                await dropbox.filesUpload({ path, contents, mode: { '.tag': 'add' }, autorename: false, strict_conflict: true, mute: true });
            } catch (error) {
                if (error.status !== 409) throw new Error('Dropbox upload failed. Retry Save PDF; the invoice has already been submitted.');
                const existing = await dropbox.filesDownload({ path });
                const bytes = existing.result?.fileBinary;
                if (!bytes || !Buffer.from(bytes).equals(contents)) throw new Error('A different PDF already exists at this PO path. Review it in Dropbox.');
            }
            await db.salesInvoice.updateOne(ctx.key, { $set: { pdfPath: path, pdfSavedAt: new Date(), pdfSourceHash: hash, transactionJson: state.json,
                transactionId: state.transactionId, invoiceNumber: invoice.invoiceNumber }, $setOnInsert: ctx.key }, { upsert: true });
        }
        return { pdfPath: path };
    };

    const download = async input => {
        const ctx = await context(input.poNumber);
        if (!ctx.record.pdfPath) throw new Error('Save the invoice PDF first');
        const dropbox = await getDropbox();
        if (!dropbox) throw new Error('Dropbox is not configured');
        const result = await dropbox.filesGetTemporaryLink({ path: ctx.record.pdfPath });
        return { url: result.result.link };
    };
    return { list, get, submit, refresh, savePdf, download };
};
module.exports = { createInvoiceFlow };
