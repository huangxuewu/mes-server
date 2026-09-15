const { createHash, randomUUID } = require('node:crypto');
const jwt = require('jsonwebtoken');
const sharp = require('sharp');
const { createOutboundWorkflowState, getMilestones } = require('./outboundWorkflowState');
const { requiresBol } = require('./outboundScac');

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

const inspectionRevision = rows => createHash('sha256').update(JSON.stringify(rows.map(row => [row.shipmentId, row.checklist.inspected, row.checklist.labeled]))).digest('hex');

const createSignaturePadWorkflow = ({ models, secret, state = createOutboundWorkflowState(models) }) => {
    const inspectionDocument = async (loadNumber, session) => {
        const document = await models.bolDocument.findOne({ loadNumber }, { number: 1, rawData: 1 }).session(session || null).lean();
        return { document, revision: createHash('sha256').update(JSON.stringify([document?.number || '', document?.rawData || null])).digest('hex') };
    };
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
        const milestones = getMilestones(records.flatMap(record => (record.loads || []).filter(load => load.loadNumber === scope.loadNumber)));
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
        const action = scope.action === 'labeled' && milestones.released ? 'loaded'
            : scope.action === 'inspected' && milestones.inspected ? 'released' : scope.action;
        const available = action === 'released' ? !milestones.released : action !== 'inspected' || milestones.labeled;
        return { ...scope, action, shipments, revision, available, milestones };
    };

    return {
        async assignShipmentBarcodes(entries) {
            const missing = [];
            for (const { load, previous } of entries) {
                if (!load?.shipmentId || !load.loadNumber) continue;
                if (previous?.inspectionRelease) load.inspectionRelease = previous.inspectionRelease;
                else delete load.inspectionRelease;
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
        async lookup(device, barcode, workflowVersion = 1) {
            const workflow = await findWorkflow(barcode);
            if (workflow.action === 'loaded' && workflowVersion < 2) throw new Error('signaturePad.updateRequired');
            if (['inspected', 'released'].includes(workflow.action) && workflowVersion < 3) throw new Error('signaturePad.updateRequired');
            const bolRevision = workflow.action === 'released' ? (await inspectionDocument(workflow.loadNumber)).revision : undefined;
            const grant = jwt.sign({ kind: 'signature-pad-workflow', deviceId: device._id, barcode, revision: workflow.revision,
                action: workflow.action, loadNumber: workflow.loadNumber, bolRevision,
                releaseId: workflow.action === 'loaded' ? workflow.milestones.releaseId : undefined,
                inspectionRevision: workflow.action === 'released' ? inspectionRevision(workflow.shipments) : undefined, jti: randomUUID() },
                secret, { expiresIn: '30m', algorithm: 'HS256' });
            return { action: workflow.action, loadNumber: workflow.loadNumber, grant, available: workflow.available,
                reason: workflow.available ? null : workflow.action === 'released' ? 'signaturePad.alreadyReleased' : 'signaturePad.labelingRequired',
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
            if (!grant.action || !grant.loadNumber) throw new Error('signaturePad.scanExpired');
            let signatureHash;
            if (grant.action === 'released') {
                if (!grant.bolRevision) throw new Error('signaturePad.updateRequired');
                if (typeof input.image !== 'string' || input.image.length > 256 * 1024
                    || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(input.image)) throw new Error('signaturePad.inspectorSignatureRequired');
                try {
                    const decoder = sharp(Buffer.from(input.image.slice(22), 'base64'), { limitInputPixels: 4096 * 4096 });
                    const metadata = await decoder.metadata();
                    if (metadata.format !== 'png') throw new Error();
                    const { data, info } = await decoder.toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
                    let ink = 0;
                    for (let i = 0; i < data.length; i += info.channels)
                        if (data[i + info.channels - 1] > 32 && Math.min(data[i], data[i + 1], data[i + 2]) < 200) ink++;
                    if (ink < 20) throw new Error();
                } catch { throw new Error('signaturePad.invalidImage'); }
                signatureHash = createHash('sha256').update(input.image).digest('hex');
            }
            const receiptId = createHash('sha256').update(JSON.stringify([input.grant, [...selected].sort()])).digest('hex');
            const completedIds = new Set();
            const receipt = await state.run([grant.loadNumber], async session => {
                    completedIds.clear();
                    const previousReceipt = await models.signaturePadWorkflowReceipt.findById(receiptId).session(session).lean();
                    if (previousReceipt) {
                        if (previousReceipt.signatureHash !== signatureHash) throw new Error('signaturePad.workflowChanged');
                        previousReceipt.completedIds.forEach(id => completedIds.add(id));
                        return { action: previousReceipt.action, loadNumber: previousReceipt.loadNumber, shipments: previousReceipt.shipments, releaseRequired: previousReceipt.releaseRequired || false };
                    }
                    const workflow = await findWorkflow(grant.barcode, session);
                    if (workflow.revision !== grant.revision || workflow.action !== grant.action || workflow.loadNumber !== grant.loadNumber) throw new Error('signaturePad.workflowChanged');
                    if (selected.some(id => !workflow.shipments.some(row => row.shipmentId === id))) throw new Error('signaturePad.invalidMessage');
                    if (!workflow.available) throw new Error(workflow.action === 'released' ? 'signaturePad.alreadyReleased' : 'signaturePad.labelingRequired');
                    if (workflow.action === 'loaded' && !workflow.milestones.released) throw new Error('signaturePad.inspectionRequired');
                    if (workflow.action === 'loaded' && grant.releaseId !== workflow.milestones.releaseId) throw new Error('signaturePad.workflowChanged');
                    const timestamp = new Date();
                    let inspectionBol;
                    if (workflow.action === 'released') {
                        const current = await inspectionDocument(workflow.loadNumber, session);
                        if (current.revision !== grant.bolRevision || inspectionRevision(workflow.shipments) !== grant.inspectionRevision)
                            throw new Error('signaturePad.workflowChanged');
                        if (selected.length !== workflow.shipments.length || !workflow.milestones.inspected) throw new Error('signaturePad.inspectionRequired');
                        inspectionBol = await models.bolDocument.findOneAndUpdate({ loadNumber: workflow.loadNumber }, {
                            $setOnInsert: { loadNumber: workflow.loadNumber },
                            $push: { inspectionSignatures: { submissionId: receiptId, image: input.image, signedAt: timestamp,
                                deviceId: device._id, shipments: workflow.shipments.map(({ outboundId, shipmentId, poNumber }) => ({ outboundId, shipmentId, poNumber })) } },
                            $inc: { revision: 1 },
                        }, { session, upsert: true, new: true });
                    }
                    const saved = [];
                    for (const row of workflow.shipments.filter(row => selected.includes(row.shipmentId))) {
                        const previous = row.checklist[workflow.action];
                        if (previous?.status === true) {
                            saved.push({ shipmentId: row.shipmentId, status: true, timestamp: previous.timestamp || null });
                            continue;
                        }
                        const parcelCompleted = workflow.action === 'loaded' && !requiresBol({ carrierSCAC: row.scac });
                        const result = await models.outbound.updateOne({ _id: row.outboundId,
                            loads: { $elemMatch: { shipmentId: row.shipmentId, loadNumber: workflow.loadNumber } } },
                        { $set: { ...(inspectionBol ? { 'loads.$[target].inspectionRelease': { id: receiptId, loadNumber: workflow.loadNumber,
                                inspectedAt: row.checklist.inspected.timestamp || null, labeledAt: row.checklist.labeled.timestamp || null } }
                                : { [`loads.$[target].checklist.${workflow.action}.status`]: true, [`loads.$[target].checklist.${workflow.action}.timestamp`]: timestamp }),
                            'loads.$[target].updatedAt': timestamp,
                            ...(inspectionBol ? { 'loads.$[target].bolId': inspectionBol._id } : {}),
                            ...(parcelCompleted ? { 'loads.$[target].status': 'Completed' } : {}) } },
                        { session, arrayFilters: [{ 'target.shipmentId': row.shipmentId, 'target.loadNumber': workflow.loadNumber }] });
                        if (result.matchedCount !== 1) throw new Error('signaturePad.workflowChanged');
                        if (parcelCompleted) completedIds.add(row.outboundId);
                        saved.push({ shipmentId: row.shipmentId, status: true, timestamp });
                    }
                    const result = { action: workflow.action, loadNumber: workflow.loadNumber, shipments: saved,
                        releaseRequired: workflow.action === 'inspected' && getMilestones(await state.readLoad(workflow.loadNumber, session)).inspected };
                    await models.signaturePadWorkflowReceipt.create([{ _id: receiptId, ...result,
                        signatureHash,
                        completedIds: [...completedIds], expiresAt: new Date(grant.exp * 1000) }], { session });
                    return result;
            });
            for (const id of completedIds) await models.order.updateShipmentStatus(await models.outbound.findById(id));
            return receipt;
        },
    };
};

module.exports = { createSignaturePadWorkflow, parseWorkflowBarcode };
