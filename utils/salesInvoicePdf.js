const PDFDocument = require('pdfkit');
const { domestic, transactionSet, amountCents } = require('./edi/invoice');

const readInvoice = (transaction, poNumber) => {
    if (!domestic(transaction) || transaction.transaction_type !== '810') throw new Error('Expected a live Target domestic invoice');
    const set = transactionSet(transaction);
    if (!set || set.transactionSetHeader?.[0]?.transactionSetIdentifierCode !== '810') throw new Error('Orderful invoice JSON is not available yet');
    const header = set.beginningSegmentForInvoice?.[0];
    if (header?.purchaseOrderNumber !== poNumber || !header.invoiceNumber || header.invoiceNumber !== transaction.business_number)
        throw new Error('Orderful invoice number or PO does not match the transaction');
    const date = String(header.date || '');
    const isoDate = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
    if (!/^\d{8}$/.test(date) || new Date(`${isoDate}T00:00:00Z`).toISOString().slice(0, 10) !== isoDate) throw new Error('Invoice date is invalid');
    const items = (set.IT1_loop || []).map((loop, index) => {
        const item = loop.baselineItemDataInvoice?.[0];
        if (!item) throw new Error('Invoice line data is missing');
        const codes = ['', '1', '2', '3'].map(suffix => ({ qualifier: item[`productServiceIDQualifier${suffix}`], value: item[`productServiceID${suffix}`] })).filter(code => code.value);
        const description = (loop.PID_loop || []).flatMap(value => value.productItemDescription || []).concat(loop.productItemDescription || []).map(value => value.description).filter(Boolean).join(' ');
        return { line: item.assignedIdentification || String(index + 1), quantity: Number(item.quantityInvoiced), unit: item.unitOrBasisForMeasurementCode,
            unitPrice: item.unitPrice, description, externalId: codes.find(code => code.qualifier === 'CB')?.value || codes[0]?.value || '',
            productCode: codes.find(code => code.qualifier === 'UP')?.value || '', codes };
    });
    if (!items.length) throw new Error('Invoice has no line items');
    const subtotalCents = amountCents(items);
    const total = set.totalMonetaryValueSummary?.[0]?.amount;
    if (!/^\d+$/.test(String(total)) || !Number.isSafeInteger(Number(total))) throw new Error('Invoice total is invalid');
    const parties = (set.N1_loop || []).map(loop => ({
        ...loop.partyIdentification?.[0],
        lines: (loop.partyLocation || []).flatMap(line => [line.addressInformation, line.addressInformation1]).filter(Boolean),
        location: (loop.geographicLocation || []).map(value => [value.cityName, value.stateOrProvinceCode, value.postalCode, value.countryCode].filter(Boolean).join(', ')),
    }));
    const terms = set.termsOfSaleDeferredTermsOfSale?.[0] || {};
    return { poNumber, invoiceNumber: header.invoiceNumber, invoiceDate: isoDate, year: date.slice(0, 4), items, subtotalCents,
        totalCents: Number(total), adjustmentCents: Number(total) - subtotalCents, parties,
        terms, carrier: set.carrierDetails?.[0] || {}, shipDate: set.dateTimeReference?.find(value => value.dateTimeQualifier === '011')?.date || '',
        transactionId: transaction.id, acknowledgment: transaction.acknowledgment_status };
};

const createSalesInvoicePdf = invoice => new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: 44, bufferPages: true, info: {
        Title: `Invoice ${invoice.invoiceNumber}`, Author: 'Down Home Manufacturing LLC',
        CreationDate: new Date(`${invoice.invoiceDate}T00:00:00Z`), ModDate: new Date(`${invoice.invoiceDate}T00:00:00Z`),
    } });
    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    const ink = '#233D36', text = '#29332F', muted = '#737A74', rule = '#DEE3DD', paper = '#F4F6F2';
    const money = cents => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
    const date = value => {
        const iso = String(value).replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3');
        return /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${iso}T00:00:00Z`)) : iso;
    };
    const write = (value, x, y, width, size = 10, color = text, font = 'Helvetica', align = 'left') => {
        doc.fillColor(color).font(font).fontSize(size).text(String(value ?? ''), x, y, { width, align, lineGap: 2 });
        return doc.y;
    };
    const line = (x, y, width, color = rule, weight = 0.6) => doc.moveTo(x, y).lineTo(x + width, y).lineWidth(weight).strokeColor(color).stroke();
    const label = (value, x, y, width) => write(value, x, y, width, 7.5, muted, 'Helvetica-Bold');
    const continuation = () => {
        doc.addPage();
        write('Down Home', 44, 37, 190, 19, ink, 'Times-Roman');
        write(`INVOICE  /  ${invoice.invoiceNumber}`, 250, 44, 318, 9, ink, 'Helvetica', 'right');
        line(44, 72, 524);
        return 92;
    };
    doc.rect(44, 35, 30, 3).fill(ink);
    write('Down Home', 44, 48, 280, 29, ink, 'Times-Roman');
    write('M A N U F A C T U R I N G   L L C', 45, 83, 300, 7.5, muted);
    write('INVOICE', 343, 44, 225, 31, ink, 'Helvetica', 'right');
    write(invoice.invoiceNumber, 315, 84, 253, 10, ink, 'Helvetica', 'right');
    line(44, 116, 524, ink, 0.9);

    const buyer = invoice.parties.find(party => party.entityIdentifierCode === 'BY') || invoice.parties.find(party => party.entityIdentifierCode === 'BT');
    label('BILL TO', 44, 139, 280);
    let buyerBottom = write(buyer?.name || 'Target', 44, 155, 295, 15, ink, 'Helvetica-Bold');
    const buyerLines = [...buyer?.lines || [], ...buyer?.location || [], buyer?.identificationCode ? `Location ${buyer.identificationCode}` : ''].filter(Boolean);
    if (buyerLines.length) buyerBottom = write(buyerLines.join('\n'), 44, buyerBottom + 4, 295, 9, muted);
    write('INVOICE TOTAL', 380, 139, 188, 7.5, muted, 'Helvetica-Bold', 'right');
    const totalBottom = write(money(invoice.totalCents), 355, 156, 213, 25, ink, 'Helvetica', 'right');
    write('USD', 480, totalBottom + 4, 88, 8, muted, 'Helvetica', 'right');

    let y = Math.max(206, buyerBottom + 18);
    const shipDate = invoice.shipDate ? date(invoice.shipDate) : null;
    doc.rect(44, y, 524, 53).fill(paper);
    label('PURCHASE ORDER', 56, y + 11, 200);
    write(invoice.poNumber, 56, y + 28, 200, 10, ink, 'Helvetica-Bold');
    label('INVOICE DATE', 280, y + 11, 126);
    write(date(invoice.invoiceDate), 280, y + 28, 126, 10);
    label(shipDate ? 'SHIP DATE' : 'CURRENCY', 437, y + 11, 119);
    write(shipDate || 'USD', 437, y + 28, 119, 10);
    y += 72;

    const tableHeader = () => {
        label('NO.', 44, y, 26);
        label('ITEM / DESCRIPTION', 78, y, 235);
        write('QTY', 316, y, 53, 7.5, muted, 'Helvetica-Bold', 'right');
        write('UNIT PRICE', 384, y, 78, 7.5, muted, 'Helvetica-Bold', 'right');
        write('AMOUNT', 477, y, 91, 7.5, muted, 'Helvetica-Bold', 'right');
        line(44, y + 19, 524, ink, 0.9);
        y += 26;
    };
    tableHeader();
    for (const item of invoice.items) {
        const code = /^\d{9}$/.test(item.externalId) ? item.externalId.replace(/^(\d{3})(\d{2})(\d{4})$/, '$1-$2-$3') : item.externalId;
        const secondary = [item.description, item.productCode ? `UPC ${item.productCode}` : ''].filter(Boolean).join('\n');
        doc.font('Helvetica-Bold').fontSize(10);
        const codeHeight = doc.heightOfString(code, { width: 226, lineGap: 2 });
        doc.font('Helvetica').fontSize(8);
        const secondaryHeight = secondary ? doc.heightOfString(secondary, { width: 226, lineGap: 2 }) : 0;
        const height = Math.max(35, codeHeight + secondaryHeight + 10);
        if (height > 540) { reject(new Error('Invoice line description is too long to render')); doc.end(); return; }
        if (y + height > 700) { y = continuation(); tableHeader(); }
        write(String(item.line).padStart(2, '0'), 44, y + 3, 26, 8, muted);
        write(code, 78, y + 2, 226, 10, text, 'Helvetica-Bold');
        if (secondary) write(secondary, 78, y + codeHeight + 5, 226, 8, muted);
        write(`${item.quantity} ${item.unit || ''}`, 316, y + 3, 53, 9, text, 'Helvetica', 'right');
        write(Number(item.unitPrice).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 }), 384, y + 3, 78, 9, text, 'Helvetica', 'right');
        write(money(amountCents([item])), 477, y + 3, 91, 10, text, 'Helvetica', 'right');
        y += height;
        line(44, y - 5, 524);
    }

    const notes = [invoice.terms.description,
        invoice.terms.termsNetDays ? `Net ${invoice.terms.termsNetDays} days` : '',
        invoice.terms.termsDiscountPercent ? `${invoice.terms.termsDiscountPercent}% discount${invoice.terms.termsDiscountDaysDue ? ` within ${invoice.terms.termsDiscountDaysDue} days` : ''}` : '',
        invoice.carrier.standardCarrierAlphaCode ? `Carrier  ${invoice.carrier.standardCarrierAlphaCode}` : '',
        invoice.carrier.referenceIdentification ? `BOL  ${invoice.carrier.referenceIdentification}` : ''].filter(Boolean);
    doc.font('Helvetica').fontSize(8.5);
    const notesHeight = notes.length ? doc.heightOfString(notes.join('\n'), { width: 262, lineGap: 2 }) + 18 : 0;
    const summaryHeight = Math.max(notesHeight, invoice.adjustmentCents ? 111 : 90) + 22;
    if (summaryHeight > 590) { reject(new Error('Invoice payment terms are too long to render')); doc.end(); return; }
    if (y + summaryHeight > 705) y = continuation();
    y += 18;
    if (notes.length) {
        label('PAYMENT & SHIPPING', 44, y, 262);
        write(notes.join('\n'), 44, y + 18, 262, 8.5, muted);
    }
    write('Subtotal', 340, y, 103, 9, muted);
    write(money(invoice.subtotalCents), 445, y, 123, 10, text, 'Helvetica', 'right');
    if (invoice.adjustmentCents) {
        y += 21;
        write('Other invoice amounts', 326, y, 130, 8, muted);
        write(money(invoice.adjustmentCents), 458, y, 110, 10, text, 'Helvetica', 'right');
    }
    line(340, y + 23, 228, ink, 1);
    label('TOTAL USD', 340, y + 38, 100);
    write(money(invoice.totalCents), 405, y + 33, 163, 23, ink, 'Helvetica', 'right');

    const pages = doc.bufferedPageRange();
    for (let page = 0; page < pages.count; page++) {
        doc.switchToPage(page);
        doc.page.margins.bottom = 24;
        line(44, 733, 524);
        write(`Down Home Manufacturing LLC  /  PO ${invoice.poNumber}`, 44, 745, 444, 7, muted);
        write(`${page + 1} / ${pages.count}`, 500, 745, 68, 7, muted, 'Helvetica', 'right');
    }
    doc.end();
});

module.exports = { readInvoice, createSalesInvoicePdf };
