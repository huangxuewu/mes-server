const { createHash } = require('node:crypto');
const jwt = require('jsonwebtoken');

const parseWorkflowBarcode = barcode => {
    if (typeof barcode !== 'string' || barcode.length > 128) throw new Error('signaturePad.invalidBarcode');
    const value = barcode.trim().replace(/^\]C[01]/, '').replace(/[\s\x1d]/g, '');
    const short = value.match(/^(?:\((402|403|404)\)|(402|403|404))(\d{9})$/);
    if (short) {
        const prefix = short[1] || short[2];
        return { action: { 402: 'inspected', 403: 'labeled', 404: 'picked' }[prefix], barcode: prefix + short[3] };
    }
    const match = value.match(/^(?:\((402|403|404)\)|(402|403|404))([a-zA-Z0-9-]{1,40})(?:\|([a-zA-Z0-9-]{1,64}))?$/);
    if (!match) throw new Error('signaturePad.invalidBarcode');
    const prefix = match[1] || match[2];
    if ((prefix === '403') !== !!match[4]) throw new Error('signaturePad.invalidBarcode');
    return { action: { 402: 'inspected', 403: 'labeled', 404: 'picked' }[prefix], loadNumber: match[3], shipmentId: match[4] || '' };
};

const createSignaturePadWorkflow = ({ models, secret }) => {
    const findWorkflow = async (barcode, session) => {
        const scope = parseWorkflowBarcode(barcode);
        if (scope.barcode) {
            let references = models.outbound.find({ [`loads.checklist.${scope.action}.barcode`]: scope.barcode }, { loads: 1 });
            if (session) references = references.session(session);
            const anchors = (await references.lean()).flatMap(record => (record.loads || [])
                .filter(load => load.checklist?.[scope.action]?.barcode === scope.barcode)
                .map(load => ({ outboundId: String(record._id), load, savedLoad: load.checklist[scope.action].barcodeLoadNumber })));
            if (!anchors.length) throw new Error('signaturePad.workflowNotFound');
            const loadNumbers = new Set(anchors.map(anchor => anchor.savedLoad));
            if (loadNumbers.size !== 1 || !anchors[0].savedLoad || anchors.length !== 1)
                throw new Error('signaturePad.workflowAmbiguous');
            scope.loadNumber = anchors[0].savedLoad;
            if (anchors[0].load.loadNumber !== scope.loadNumber) throw new Error('signaturePad.workflowChanged');
            if (scope.action === 'labeled') {
                scope.shipmentId = anchors[0].load.shipmentId;
                scope.outboundId = anchors[0].outboundId;
            }
        }
        let query = models.outbound.find({ 'loads.loadNumber': scope.loadNumber }, { loads: 1, poNumber: 1, items: 1 });
        if (session) query = query.session(session);
        const records = await query.lean();
        const scopedShipments = records.filter(record => !scope.outboundId || String(record._id) === scope.outboundId).flatMap(record => (record.loads || [])
            .filter(load => load.loadNumber === scope.loadNumber && (!scope.shipmentId || load.shipmentId === scope.shipmentId))
            .map(load => ({ outboundId: String(record._id), shipmentId: load.shipmentId, poNumber: record.poNumber || '',
                dc: (record.poNumber || '').split('-')[1] || '',
                scac: load.carrierSCAC || load.executingSCAC || load.assignedSCAC || '',
                status: load.status, items: load.items === undefined ? (record.items || []) : load.items, checklist: load.checklist || {} })));
        if (!scopedShipments.length) throw new Error('signaturePad.workflowNotFound');
        if (scopedShipments.some(row => !row.shipmentId) || new Set(scopedShipments.map(row => row.shipmentId)).size !== scopedShipments.length
            || (scope.shipmentId && scopedShipments.length !== 1)) throw new Error('signaturePad.workflowAmbiguous');
        const shipments = scopedShipments.filter(row => !['Completed', 'Cancelled'].includes(row.status));
        if (!shipments.length) throw new Error('signaturePad.workflowClosed');
        if (shipments.some(row => !Array.isArray(row.items) || !row.items.length || row.items.some(item => !item.styleCode || !Number.isFinite(item.quantity)
            || item.quantity < 0 || !Number.isFinite(item.casePack) || item.casePack <= 0))) throw new Error('signaturePad.workflowNotReady');
        shipments.sort((a, b) => a.poNumber.localeCompare(b.poNumber) || a.shipmentId.localeCompare(b.shipmentId));
        const revision = createHash('sha256').update(JSON.stringify(shipments.map(({ checklist, ...row }) => row))).digest('hex');
        return { ...scope, shipments, revision };
    };

    return {
        async assignShipmentBarcodes(entries) {
            const missing = [];
            for (const { load, previous } of entries) {
                if (!load?.shipmentId || !load.loadNumber) continue;
                load.checklist = { ...previous?.checklist, ...load.checklist };
                for (const [action, prefix] of [['picked', '404'], ['inspected', '402'], ['labeled', '403']]) {
                    const saved = previous?.checklist?.[action];
                    const entry = { ...saved, ...load.checklist[action] };
                    if (saved?.barcodeLoadNumber === load.loadNumber && new RegExp('^' + prefix + '\\d{9}$').test(saved.barcode)) {
                        entry.barcode = saved.barcode; entry.barcodeLoadNumber = saved.barcodeLoadNumber;
                    } else {
                        delete entry.barcode; delete entry.barcodeLoadNumber;
                        missing.push({ entry, prefix, loadNumber: load.loadNumber });
                    }
                    load.checklist[action] = entry;
                }
            }
            if (!missing.length) return;
            let counter;
            for (let attempt = 0; attempt < 2; attempt++) {
                try {
                    counter = await models.counter.findByIdAndUpdate('signature-pad-checklist', { $inc: { sequence: missing.length } },
                        { new: true, upsert: true, setDefaultsOnInsert: false });
                    break;
                } catch (error) { if (error.code !== 11000 || attempt) throw error; }
            }
            if (!counter || !Number.isSafeInteger(counter.sequence) || counter.sequence > 999999999 || counter.sequence < missing.length)
                throw new Error('signaturePad.barcodeExhausted');
            for (const [index, { entry, prefix, loadNumber }] of missing.entries()) {
                entry.barcode = prefix + String(counter.sequence - missing.length + index + 1).padStart(9, '0');
                entry.barcodeLoadNumber = loadNumber;
            }
        },
        async lookup(device, barcode) {
            const workflow = await findWorkflow(barcode);
            const grant = jwt.sign({ kind: 'signature-pad-workflow', deviceId: device._id, barcode, revision: workflow.revision },
                secret, { expiresIn: '30m', algorithm: 'HS256' });
            return { action: workflow.action, loadNumber: workflow.loadNumber, grant,
                shipments: workflow.shipments.map(row => ({ ...row,
                    items: row.items.map(item => ({ styleCode: item.styleCode, description: item.description || '',
                        quantity: item.quantity, casePack: item.casePack, boxes: item.quantity / item.casePack }))
                        .sort((a, b) => b.boxes - a.boxes) })) };
        },
        async confirm(device, input) {
            let grant;
            try { grant = jwt.verify(input?.grant, secret, { algorithms: ['HS256'] }); }
            catch { throw new Error('signaturePad.scanExpired'); }
            if (grant.kind !== 'signature-pad-workflow' || grant.deviceId !== device._id) throw new Error('signaturePad.deviceUnauthorized');
            const selected = input?.shipmentIds;
            if (!Array.isArray(selected) || !selected.length || selected.some(id => typeof id !== 'string')
                || new Set(selected).size !== selected.length) throw new Error('signaturePad.invalidMessage');
            const session = await models.outbound.startSession();
            try {
                let receipt;
                await session.withTransaction(async () => {
                    const workflow = await findWorkflow(grant.barcode, session);
                    if (workflow.revision !== grant.revision) throw new Error('signaturePad.workflowChanged');
                    if (selected.some(id => !workflow.shipments.some(row => row.shipmentId === id))) throw new Error('signaturePad.invalidMessage');
                    const timestamp = new Date();
                    const saved = [];
                    for (const row of workflow.shipments.filter(row => selected.includes(row.shipmentId))) {
                        const previous = row.checklist[workflow.action];
                        if (previous?.status === true) {
                            saved.push({ shipmentId: row.shipmentId, status: true, timestamp: previous.timestamp || null });
                            continue;
                        }
                        const result = await models.outbound.updateOne({ _id: row.outboundId,
                            loads: { $elemMatch: { shipmentId: row.shipmentId, loadNumber: workflow.loadNumber } } },
                        { $set: { [`loads.$[target].checklist.${workflow.action}.status`]: true,
                            [`loads.$[target].checklist.${workflow.action}.timestamp`]: timestamp,
                            'loads.$[target].updatedAt': timestamp } },
                        { session, arrayFilters: [{ 'target.shipmentId': row.shipmentId, 'target.loadNumber': workflow.loadNumber }] });
                        if (result.matchedCount !== 1) throw new Error('signaturePad.workflowChanged');
                        saved.push({ shipmentId: row.shipmentId, status: true, timestamp });
                    }
                    receipt = { action: workflow.action, loadNumber: workflow.loadNumber, shipments: saved };
                });
                return receipt;
            } finally { await session.endSession(); }
        },
    };
};

module.exports = { createSignaturePadWorkflow, parseWorkflowBarcode };
