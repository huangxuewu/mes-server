const { createHash } = require('node:crypto');
const { REFRESH_INVOICE, CREATE_INVOICE, domestic, isPoLoaded, inspectInvoice, buildInvoice, invoiceFingerprint, readPurchaseOrders, amountCents } = require('./invoice');
const { readInvoice, createSalesInvoicePdf } = require('../salesInvoicePdf');

const createInvoiceFlow = ({ db, getClient, getDropbox, getOrderfulMessage }) => {
    const isPending = (invoice, record = {}) => Boolean((invoice?.id || record.transactionId || record.submissionStartedAt)
        && !['ACCEPTED', 'REJECTED', 'ACCEPTEDWITHERRORS'].includes(invoice?.acknowledgment_status || record.acknowledgmentStatus)
        && (invoice?.validation_status || record.validationStatus) !== 'INVALID'
        && (invoice?.delivery_status || record.deliveryStatus) !== 'FAILED');
    const bolUrls = mes => Object.fromEntries((mes.loads || []).filter(load => load.loadNumber && load.bol?.url)
        .map(load => [load.loadNumber, load.bol.url]));
    const latestTime = values => {
        const times = values.filter(Boolean).map(value => new Date(value).getTime()).filter(Number.isFinite);
        return times.length ? new Date(Math.max(...times)).toISOString() : null;
    };
    const timeline = (po, mes, record = {}) => {
        const loads = (mes.loads || []).filter(load => !['Cancelled', 'Canceled'].includes(load.status));
        const transactions = (po?.edi_transaction || []).filter(domestic);
        const invoice = transactions.find(transaction => transaction.transaction_type === '810');
        const shippedAt = latestTime(loads.filter(load => load.checklist?.loaded?.status === true)
            .map(load => load.checklist.loaded.timestamp));
        const shippedLoad = loads.find(load => shippedAt && load.checklist?.loaded?.status === true
            && +new Date(load.checklist.loaded.timestamp) === +new Date(shippedAt)) || (loads.length === 1 ? loads[0] : null);
        const asnTimes = loads.map(load => {
            const shipment = (po?.load_shipments || []).find(shipment => String(shipment.load_shipment_notice_id) === String(load.shipmentId)
                && shipment.load?.load_number === load.loadNumber);
            const asn = transactions.filter(transaction => transaction.transaction_type === '856'
                && shipment && String(transaction.business_number) === String(shipment.id))
                .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
            return asn?.acknowledgment_status === 'ACCEPTED' && load.asn?.state === 'accepted' && load.asn.final
                && String(asn.id) === String(load.asn.transactionId) ? load.checklist?.noticed?.acceptedAt || load.asn.checkedAt : null;
        });
        const invoiceTimes = loads.map(load => String(load.checklist?.invoiced?.transactionId) === String(invoice?.id)
            ? load.checklist?.invoiced?.acceptedAt : null);
        const submittedTimes = loads.map(load => String(load.checklist?.invoiced?.transactionId) === String(invoice?.id || record.transactionId)
            ? load.checklist?.invoiced?.timestamp : null);
        const asnSubmittedAt = latestTime(loads.map(load => load.checklist?.noticed?.status ? load.checklist.noticed.timestamp : null));
        const asnAt = asnTimes.every(Boolean) ? latestTime(asnTimes) : null;
        const asnSubmittedLoad = loads.find(load => asnSubmittedAt && load.checklist?.noticed?.status
            && +new Date(load.checklist.noticed.timestamp) === +new Date(asnSubmittedAt)) || (loads.length === 1 ? loads[0] : null);
        const asnAcceptedLoad = loads.find((load, index) => asnAt && +new Date(asnTimes[index]) === +new Date(asnAt))
            || (loads.length === 1 ? loads[0] : null);
        return {
            shipped: isPoLoaded(mes),
            shippedAt, shippedLoadNumber: shippedLoad?.loadNumber || null,
            asnSubmitted: loads.some(load => load.checklist?.noticed?.status) || transactions.some(transaction => transaction.transaction_type === '856'),
            asnSubmittedAt, asnSubmittedLoadNumber: asnSubmittedLoad?.loadNumber || null,
            asnAt, asnAcceptedLoadNumber: asnAcceptedLoad?.loadNumber || null,
            invoicedAt: (submittedTimes.every(Boolean) ? latestTime(submittedTimes) : null)
                || invoice?.created_at || (record.transactionId ? record.submissionStartedAt : null) || null,
            invoiceAcceptedAt: invoice?.acknowledgment_status === 'ACCEPTED' && invoiceTimes.every(Boolean) ? latestTime(invoiceTimes) : null,
        };
    };
    const saveInvoiceChecklist = async (ctx, transaction) => {
        const transactionId = String(transaction.id);
        const target = { 'target.status': 'Completed', 'target.checklist.noticed': { $exists: true } };
        const timestamp = transaction.created_at || ctx.record.submissionStartedAt || null;
        await db.outbound.updateOne({ poNumber: ctx.mes.poNumber, client: 'Target' }, {
            $set: { 'loads.$[target].checklist.invoiced': { status: true, timestamp, transactionId, acceptedAt: null } },
        }, { arrayFilters: [{ ...target, 'target.checklist.invoiced.transactionId': { $ne: transactionId } }], runValidators: true });
        if (transaction.acknowledgment_status === 'ACCEPTED') {
            await db.outbound.updateOne({ poNumber: ctx.mes.poNumber, client: 'Target' }, {
                $set: { 'loads.$[target].checklist.invoiced.acceptedAt': new Date() },
            }, { arrayFilters: [{ ...target, 'target.checklist.invoiced.transactionId': transactionId,
                'target.checklist.invoiced.acceptedAt': null }], runValidators: true });
        }
        ctx.mes = await db.outbound.findOne({ poNumber: ctx.mes.poNumber, client: 'Target' }).lean();
    };
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
            preview, json, bolUrls: bolUrls(mes), timeline: timeline(po, mes, record), inQueue: state.ready || isPending(state.invoice, record),
            invoiceDate, fingerprint: message ? invoiceFingerprint(message) : '',
            erpUrl: `${client.config.webBaseUrl.replace(/\/$/, '')}/shipping/invoice/${state.transactionId ? 'detail' : 'send'}/${encodeURIComponent(po.po_number)}`,
            orderfulUrl: state.transactionId ? `https://ui.orderful.com/transactions/${encodeURIComponent(state.transactionId)}` : '',
            canSavePdf: !!invoice && state.invoice?.validation_status === 'VALID'
                && state.invoice?.delivery_status !== 'FAILED' && !['REJECTED', 'ACCEPTEDWITHERRORS'].includes(state.invoice?.acknowledgment_status),
        };
    };
    const get = async ({ poNumber, invoiceDate }) => {
        const ctx = await context(poNumber);
        const detail = present(ctx, invoiceDate);
        // ERP form defaults are for review only; the submission payload remains unchanged.
        const { vendor_id, vendor_name, department, destinationCenter, load_shipments,
            payment_type_code, payment_basis_date_code, payment_terms_discount,
            payment_discount_days_due, payment_terms_net_days } = ctx.po;
        return { ...detail, erpSource: {
            vendor_id, vendor_name, department, destinationCenter, load_shipments,
            payment_type_code, payment_basis_date_code, payment_terms_discount,
            payment_discount_days_due, payment_terms_net_days,
            invoiceDate: new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date()),
        } };
    };

    const list = async () => {
        const client = await getClient();
        const integrationKey = createHash('sha256').update(`${client.config.baseUrl}:${client.headers['x-tenant-id'] || ''}:OFDHTGTDMS`).digest('hex');
        const records = await db.salesInvoice.find({ integrationKey }, { poNumber: 1, transactionId: 1, submissionStartedAt: 1,
            invoiceNumber: 1, validationStatus: 1, deliveryStatus: 1, acknowledgmentStatus: 1, pdfPath: 1 }).lean();
        const submitted = records.filter(record => record.transactionId || record.submissionStartedAt);
        const query = { client: 'Target', loads: { $elemMatch: { status: 'Completed', 'checklist.noticed': { $exists: true } } },
            $or: [
                { poNumber: { $in: submitted.filter(record => isPending(null, record)).map(record => record.poNumber) } },
                { poNumber: { $nin: submitted.map(record => record.poNumber) }, loads: { $not: { $elemMatch: {
                    status: { $nin: ['Completed', 'Cancelled', 'Canceled'] },
                } } } },
            ] };
        const selected = await db.outbound.find(query, { poNumber: 1, client: 1, items: 1, 'loads.items': 1, 'loads.loadNumber': 1, 'loads.shipmentId': 1,
            'loads.status': 1, 'loads.checklist.loaded': 1, 'loads.checklist.invoiced': 1, 'loads.asn': 1,
            'loads.checklist.noticed': 1, 'loads.bol.url': 1 }).sort({ updatedAt: -1, _id: 1 }).lean();
        if (!selected.length) return { rows: [] };
        const numbers = selected.map(mes => mes.poNumber);
        const orders = await readPurchaseOrders(client, numbers);
        const rows = selected.map(mes => {
            const record = records.find(record => record.poNumber === mes.poNumber) || {};
            const loads = (mes.loads || []).filter(load => load.status === 'Completed' && Object.hasOwn(load.checklist || {}, 'noticed'));
            const shipment = { loadNumbers: [...new Set(loads.map(load => load.loadNumber).filter(Boolean))], bolUrls: bolUrls({ loads }) };
            try {
                const matches = orders.filter(po => po.po_number === mes.poNumber);
                if (matches.length !== 1) throw new Error('ERP purchase order was not found uniquely');
                const state = inspectInvoice(matches[0], mes, record);
                if (!state.ready && !isPending(state.invoice, record)) return null;
                return { poNumber: state.poNumber, invoiceNumber: state.invoiceNumber, totalCents: state.totalCents, ready: state.ready,
                    asnAccepted: state.asnAccepted, reasons: state.reasons, pdfPath: state.pdfPath, transactionId: state.transactionId,
                    acknowledgment: state.invoice?.acknowledgment_status || '', timeline: timeline(matches[0], mes, record), ...shipment };
            } catch (error) { return isPending(null, record) ? { poNumber: mes.poNumber, ...shipment, ready: false,
                transactionId: record.transactionId, invoiceNumber: record.invoiceNumber, pdfPath: record.pdfPath,
                acknowledgment: record.acknowledgmentStatus || '', timeline: timeline(null, mes, record), error: error.message } : null; }
        }).filter(Boolean);
        return { rows };
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
        ctx.record = claimed;
        await saveInvoiceChecklist(ctx, { id: transactionId });
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
            await authorize();
            await saveInvoiceChecklist(ctx, current.invoice);
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
