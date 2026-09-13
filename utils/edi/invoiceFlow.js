const { createHash } = require('node:crypto');
const { CREATE_INVOICE, domestic, isPoLoaded, inspectInvoice, invoiceReview, buildInvoice, invoiceFingerprint, readPurchaseOrders, amountCents } = require('./invoice');
const { createOrderfulClient, readOrderfulPo } = require('./orderful');
const { readInvoice, createSalesInvoicePdf } = require('../salesInvoicePdf');

const createInvoiceFlow = ({ db, getClient, getDropbox, getOrderfulTransaction = createOrderfulClient({ db }) }) => {
    const isPending = (invoice, record = {}) => Boolean((invoice?.id || record.transactionId || record.submissionStartedAt)
        && (record.statusSource !== 'orderful' && !invoice || !['ACCEPTED', 'REJECTED', 'ACCEPTEDWITHERRORS'].includes(invoice?.acknowledgment_status || record.acknowledgmentStatus)
        && (invoice?.validation_status || record.validationStatus) !== 'INVALID'
        && (invoice?.delivery_status || record.deliveryStatus) !== 'FAILED'));
    const bolUrls = mes => Object.fromEntries((mes.loads || []).filter(load => load.loadNumber && load.bol?.url)
        .map(load => [load.loadNumber, load.bol.url]));
    const latestTime = values => {
        const times = values.filter(Boolean).map(value => new Date(value).getTime()).filter(Number.isFinite);
        return times.length ? new Date(Math.max(...times)).toISOString() : null;
    };
    const timeline = (po, mes) => {
        const loads = (mes.loads || []).filter(load => !['Cancelled', 'Canceled'].includes(load.status));
        const transactions = (po?.edi_transaction || []).filter(domestic);
        const invoice = transactions.find(transaction => transaction.transaction_type === '810');
        const shippedAt = latestTime(loads.filter(load => load.checklist?.loaded?.status === true)
            .map(load => load.checklist.loaded.timestamp));
        const shippedLoad = loads.find(load => shippedAt && load.checklist?.loaded?.status === true
            && +new Date(load.checklist.loaded.timestamp) === +new Date(shippedAt)) || (loads.length === 1 ? loads[0] : null);
        const asns = loads.map(load => {
            const shipment = (po?.load_shipments || []).find(shipment => String(shipment.load_shipment_notice_id) === String(load.shipmentId)
                && shipment.load?.load_number === load.loadNumber);
            return transactions.filter(transaction => transaction.transaction_type === '856'
                && shipment && String(transaction.business_number) === String(shipment.id))
                .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
        });
        const asnTimes = asns.map(asn => asn?.acknowledgment_status === 'ACCEPTED' ? asn.accepted_at : null);
        const asnSubmittedAt = latestTime(asns.map(asn => asn?.created_at));
        const asnAt = asnTimes.every(Boolean) ? latestTime(asnTimes) : null;
        const asnSubmittedLoad = loads.find((load, index) => asnSubmittedAt && +new Date(asns[index]?.created_at) === +new Date(asnSubmittedAt)) || (loads.length === 1 ? loads[0] : null);
        const asnAcceptedLoad = loads.find((load, index) => asnAt && +new Date(asnTimes[index]) === +new Date(asnAt))
            || (loads.length === 1 ? loads[0] : null);
        return {
            shipped: isPoLoaded(mes),
            shippedAt, shippedLoadNumber: shippedLoad?.loadNumber || null,
            asnSubmitted: transactions.some(transaction => transaction.transaction_type === '856'),
            asnSubmittedAt, asnSubmittedLoadNumber: asnSubmittedLoad?.loadNumber || null,
            asnAt, asnAcceptedLoadNumber: asnAcceptedLoad?.loadNumber || null,
            invoicedAt: invoice?.created_at || null,
            invoiceAcceptedAt: invoice?.acknowledgment_status === 'ACCEPTED' ? invoice.accepted_at : null,
        };
    };
    const saveInvoiceChecklist = async (ctx, transaction) => {
        const transactionId = String(transaction.id);
        const target = { 'target.status': 'Completed', 'target.checklist.noticed.status': { $exists: true } };
        await db.outbound.updateOne({ poNumber: ctx.mes.poNumber, client: 'Target' }, {
            $set: { 'loads.$[target].checklist.invoiced': { status: true, timestamp: transaction.created_at || null, transactionId,
                acceptedAt: transaction.acknowledgment_status === 'ACCEPTED' ? transaction.accepted_at : null } },
        }, { arrayFilters: [target], runValidators: true });
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
        const orders = await readPurchaseOrders(client, [poNumber], false);
        if (orders.length !== 1) throw new Error('ERP purchase order was not found uniquely');
        const record = await db.salesInvoice.findOne(key).lean() || {};
        return { client, key, mes, po: await readOrderfulPo(orders[0], mes, record, getOrderfulTransaction), record };
    };
    const present = ({ client, po, mes, record }, invoiceDate) => {
        const state = inspectInvoice(po, mes, record);
        const json = state.invoice?.document?.json_data || null;
        const invoice = json && state.invoice ? readInvoice({ ...state.invoice, document: { json_data: json } }, po.po_number) : null;
        const message = state.ready ? buildInvoice(po, state, invoiceDate) : null;
        const preview = invoice || (state.transactionId ? null : { poNumber: state.poNumber, invoiceNumber: state.invoiceNumber,
            totalCents: state.totalCents, items: state.items, buyer: state.buyer, invoiceDate });
        if (preview) preview.items = preview.items.map(item => ({ ...item, lineTotalCents: amountCents([item]) }));
        return { ...state, invoice: state.invoice ? { id: state.invoice.id, validation: state.invoice.validation_status,
            delivery: state.invoice.delivery_status, acknowledgment: state.invoice.acknowledgment_status } : null,
            preview, json, bolUrls: bolUrls(mes), timeline: timeline(po, mes), inQueue: state.ready || isPending(state.invoice, record),
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
        const { vendor_id, vendor_name, department, destinationCenter, load_shipments,
            payment_type_code, payment_basis_date_code, payment_terms_discount,
            payment_discount_days_due, payment_terms_net_days } = ctx.po;
        const review = !detail.transactionId ? invoiceReview(ctx.po, detail, invoiceDate) : null;
        return { ...detail, review, reviewFingerprint: review ? invoiceFingerprint({ fingerprint: detail.fingerprint, review }) : '', erpSource: {
            vendor_id, vendor_name, department, destinationCenter, load_shipments,
            payment_type_code, payment_basis_date_code, payment_terms_discount,
            payment_discount_days_due, payment_terms_net_days,
            invoiceDate,
        } };
    };

    const verifyQueue = async suppliedClient => {
        const client = suppliedClient || await getClient();
        const integrationKey = createHash('sha256').update(`${client.config.baseUrl}:${client.headers['x-tenant-id'] || ''}:OFDHTGTDMS`).digest('hex');
        const records = await db.salesInvoice.find({ integrationKey }, { poNumber: 1, transactionId: 1, submissionStartedAt: 1,
            invoiceNumber: 1, validationStatus: 1, deliveryStatus: 1, acknowledgmentStatus: 1, statusSource: 1, pdfPath: 1 }).lean();
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
        const orders = await readPurchaseOrders(client, numbers, false);
        const ordersByNumber = new Map();
        for (const po of orders) ordersByNumber.set(po.po_number, [...(ordersByNumber.get(po.po_number) || []), po]);
        const recordsByNumber = new Map(records.map(record => [record.poNumber, record]));
        const rows = [];
        const verificationErrors = [];
        for (let offset = 0; offset < selected.length; offset += 4) {
            rows.push(...await Promise.all(selected.slice(offset, offset + 4).map(async mes => {
                const record = recordsByNumber.get(mes.poNumber) || {};
                const loads = (mes.loads || []).filter(load => load.status === 'Completed' && Object.hasOwn(load.checklist || {}, 'noticed'));
                const shipment = { loadNumbers: [...new Set(loads.map(load => load.loadNumber).filter(Boolean))], bolUrls: bolUrls({ loads }) };
                try {
                    const matches = ordersByNumber.get(mes.poNumber) || [];
                    if (matches.length !== 1) throw new Error('ERP purchase order was not found uniquely');
                    // ERP invoice presence identifies pre-feature history; it is not used as an acknowledgment.
                    if (!record.transactionId && !record.submissionStartedAt && (matches[0].edi_transaction || []).some(transaction => domestic(transaction) && transaction.transaction_type === '810')) return null;
                    const po = await readOrderfulPo(matches[0], mes, record, getOrderfulTransaction).catch(error => { verificationErrors.push(error); throw error; });
                    const state = inspectInvoice(po, mes, record);
                    if (!state.ready && !isPending(state.invoice, record)) return null;
                    return { poNumber: state.poNumber, invoiceNumber: state.invoiceNumber, totalCents: state.totalCents, ready: state.ready,
                        asnAccepted: state.asnAccepted, reasons: state.reasons, pdfPath: state.pdfPath, transactionId: state.transactionId,
                        acknowledgment: state.invoice?.acknowledgment_status || '', timeline: timeline(po, mes), ...shipment };
                } catch (error) { return isPending(null, record) ? { poNumber: mes.poNumber, ...shipment, ready: false,
                    transactionId: record.transactionId, invoiceNumber: record.invoiceNumber, pdfPath: record.pdfPath,
                    acknowledgment: '', timeline: timeline(null, mes), error: error.message } : null; }
            })));
        }
        if (verificationErrors.length) throw new Error(`Orderful verification failed: ${verificationErrors[0].message}`);
        return { rows: rows.filter(Boolean) };
    };

    const syncList = async () => {
        const checkedAt = new Date();
        const client = await getClient();
        const integrationKey = createHash('sha256').update(`${client.config.baseUrl}:${client.headers['x-tenant-id'] || ''}:OFDHTGTDMS`).digest('hex');
        const result = await verifyQueue(client);
        for (const [position, row] of result.rows.entries()) {
            try {
                await db.salesInvoice.updateOne({ integrationKey, poNumber: row.poNumber,
                    $or: [{ queueCheckedAt: { $lt: checkedAt } }, { queueCheckedAt: null }] }, {
                    $set: { queueRow: { ...row, position }, queueCheckedAt: checkedAt }, $setOnInsert: { integrationKey, poNumber: row.poNumber },
                }, { upsert: true });
            } catch (error) {
                // A newer monitor run may have saved this PO while this check was in flight.
                if (error.code !== 11000) throw error;
            }
        }
        await db.salesInvoice.updateMany({ integrationKey, poNumber: { $nin: result.rows.map(row => row.poNumber) },
            queueCheckedAt: { $lt: checkedAt } }, { $set: { queueRow: null, queueCheckedAt: checkedAt } });
        return result;
    };

    const list = async () => {
        const client = await getClient();
        const integrationKey = createHash('sha256').update(`${client.config.baseUrl}:${client.headers['x-tenant-id'] || ''}:OFDHTGTDMS`).digest('hex');
        const records = await db.salesInvoice.find({ integrationKey, queueRow: { $ne: null } }, {
            poNumber: 1, queueRow: 1, queueCheckedAt: 1, transactionId: 1, submissionStartedAt: 1, invoiceNumber: 1,
            statusSource: 1, validationStatus: 1, deliveryStatus: 1, acknowledgmentStatus: 1, submittedAt: 1, acceptedAt: 1, pdfPath: 1,
        }).sort({ 'queueRow.position': 1, poNumber: 1 }).lean();
        const rows = [];
        for (const record of records) {
            const row = record.queueRow;
            if (!row || !record.queueCheckedAt) continue;
            const submitted = record.transactionId || record.submissionStartedAt;
            if (submitted && !isPending(null, record)) continue;
            const verified = record.statusSource === 'orderful';
            rows.push({ ...row, checkedAt: record.queueCheckedAt,
                ready: row.ready && !submitted,
                transactionId: record.transactionId || row.transactionId,
                invoiceNumber: record.invoiceNumber || row.invoiceNumber,
                pdfPath: record.pdfPath || row.pdfPath,
                ...(submitted ? { acknowledgment: verified ? record.acknowledgmentStatus : '',
                    timeline: { ...row.timeline, invoicedAt: verified ? record.submittedAt : null,
                        invoiceAcceptedAt: verified ? record.acceptedAt : null } } : {}),
            });
        }
        return { rows };
    };

    const submit = async ({ poNumber, invoiceDate, fingerprint, review, reviewFingerprint }, actor, authorize = async () => {}) => {
        await db.salesInvoice.init();
        const ctx = await context(poNumber);
        let state = inspectInvoice(ctx.po, ctx.mes, ctx.record);
        if (state.transactionId) return { transactionId: state.transactionId, existing: true };
        if (!state.ready) throw new Error(`Invoice is not ready: ${state.reasons.join(', ')}`);
        // Re-read Orderful immediately before the final eligibility check; ERP only supplies PO defaults.
        const freshOrders = await readPurchaseOrders(ctx.client, [poNumber], false);
        if (freshOrders.length !== 1) throw new Error('ERP PO changed. Refresh the invoice preview.');
        ctx.po = await readOrderfulPo(freshOrders[0], ctx.mes, ctx.record, getOrderfulTransaction);
        ctx.mes = await db.outbound.findOne({ poNumber }).lean();
        state = inspectInvoice(ctx.po, ctx.mes, ctx.record);
        if (state.transactionId) return { transactionId: state.transactionId, existing: true };
        const baseline = buildInvoice(ctx.po, state, invoiceDate);
        if (!fingerprint || fingerprint !== invoiceFingerprint(baseline)) throw new Error('Invoice data changed. Refresh and review the preview before submitting.');
        if (review && reviewFingerprint !== invoiceFingerprint({ fingerprint, review: invoiceReview(ctx.po, state, invoiceDate) }))
            throw new Error('ERP invoice defaults changed. Review the invoice again.');
        const message = review ? buildInvoice(ctx.po, state, invoiceDate, review) : baseline;
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
            $set: { submissionStartedAt: new Date(), submittedBy: String(actor), submittedMessage: message,
                invoiceNumber: message.transactionSets[0].beginningSegmentForInvoice[0].invoiceNumber, invoiceDate: review?.invoiceDate || invoiceDate },
        }, { new: true });
        if (!claimed) throw new Error('An invoice submission already exists. Refresh its status; do not send again.');
        // Keep the durable claim even when ERP times out. A later refresh reconciles the result.
        await authorize();
        const result = await ctx.client.graphql(CREATE_INVOICE, { input: { account_code: 'Domestic', stream: 'LIVE', type: 'INVOICE_810', message } });
        const transactionId = result?.createTransaction?.id;
        if (!transactionId) throw new Error('ERP returned no transaction ID. Refresh or review ERP before retrying.');
        await db.salesInvoice.updateOne(ctx.key, { $set: { transactionId: String(transactionId) } });
        ctx.record = { ...claimed, transactionId: String(transactionId) };
        // The durable claim is local dispatch history; it is never shown as the Orderful submission timestamp.
        // The next refresh records Orderful's createdAt and acknowledgment.createdAt.
        return { transactionId: String(transactionId) };
    };

    const refresh = async (input, authorize = async () => {}) => {
        const ctx = await context(input.poNumber);
        const current = inspectInvoice(ctx.po, ctx.mes, ctx.record);
        if (current.invoice) {
            await authorize();
            await saveInvoiceChecklist(ctx, current.invoice);
            const json = current.invoice.document?.json_data;
            if (json) readInvoice({ ...current.invoice, document: { json_data: json } }, input.poNumber);
            await authorize();
            const update = { transactionId: current.invoice.id, invoiceNumber: current.invoice.business_number,
                validationStatus: current.invoice.validation_status, deliveryStatus: current.invoice.delivery_status,
                acknowledgmentStatus: current.invoice.acknowledgment_status, statusSource: 'orderful',
                submittedAt: current.invoice.created_at, acceptedAt: current.invoice.accepted_at, statusCheckedAt: new Date(), ...(json ? { transactionJson: json } : {}) };
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
    return { list, verifyQueue, syncList, get, submit, refresh, savePdf, download };
};
module.exports = { createInvoiceFlow };
