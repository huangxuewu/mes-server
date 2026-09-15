const { buildBolWorkflow, applyBolWorkflow } = require('./bolWorkflow');

const createBolDocumentService = models => {
    const { outbound, bolDocument } = models;
    const workflows = async documents => {
        if (!documents.length) return new Map();
        const records = await outbound.find({ $or: documents.map(document => document.loadNumber
            ? { 'loads.loadNumber': document.loadNumber } : { 'loads.shipmentId': document.shipmentId }) },
            { poNumber: 1, loads: 1 }).lean();
        return new Map(documents.map(document => [String(document._id), buildBolWorkflow(document, records)]));
    };
    const get = async ({ loadNumber, documentId, shipmentId }) => {
        if ([loadNumber, documentId, shipmentId].some(value => value != null && typeof value !== 'string')) throw new Error('Invalid BOL identity');
        if (!loadNumber && !documentId && !shipmentId) throw new Error('BOL load number or shipment ID is required');
        const document = await bolDocument.findOne(documentId ? { _id: documentId, ...(loadNumber ? { loadNumber } : {}) }
            : loadNumber ? { loadNumber } : { loadNumber: '', shipmentId }).lean();
        return document ? { ...document, workflow: (await workflows([document])).get(String(document._id)) } : null;
    };
    const sync = async ({ targets }) => {
        if (!Array.isArray(targets) || targets.length > 20) throw new Error('Invalid BOL cache targets');
        const selectors = targets.map(target => {
            if (!target || typeof target !== 'object' || [target.loadNumber, target.shipmentId].some(value => value != null && (typeof value !== 'string' || value.length > 128))
                || (!target.loadNumber && !target.shipmentId)) throw new Error('Invalid BOL identity');
            return target.loadNumber ? { loadNumber: target.loadNumber } : { loadNumber: '', shipmentId: target.shipmentId };
        });
        if (!selectors.length) return [];
        const metadata = await bolDocument.find({ $or: selectors }, { loadNumber: 1, shipmentId: 1, revision: 1, updatedAt: 1,
            inspectionSignatures: 1 }).lean();
        const currentWorkflows = await workflows(metadata);
        const changed = targets.map((target, index) => {
            const current = metadata.find(document => selectors[index].loadNumber
                ? document.loadNumber === target.loadNumber : !document.loadNumber && document.shipmentId === target.shipmentId);
            const unchanged = current && String(current._id) === target.documentId && current.revision === target.revision
                && (current.updatedAt?.toISOString() || null) === (target.updatedAt || null);
            return { current, unchanged };
        });
        const ids = [...new Map(changed.filter(row => row.current && !row.unchanged).map(row => [String(row.current._id), row.current._id])).values()];
        const documents = ids.length ? await bolDocument.find({ _id: { $in: ids } }).lean() : [];
        return changed.map(({ current, unchanged }) => {
            const workflow = currentWorkflows.get(String(current?._id));
            const document = documents.find(document => String(document._id) === String(current?._id));
            return unchanged ? { unchanged: true, workflow } : { document: document ? { ...document, workflow } : null };
        });
    };
    const save = async ({ loadNumber = '', shipmentId, documentId, rawData, number, url, revision, shipmentIds, clear = false }) => {
        if (typeof loadNumber !== 'string' || (!loadNumber.trim() && !shipmentId)) throw new Error('BOL load number or shipment ID is required');
        const selector = loadNumber ? { loadNumber } : { shipmentId, loadNumber: { $in: ['', null] } };
        const documentSelector = loadNumber ? { loadNumber } : { loadNumber: '', shipmentId };
        const session = await outbound.startSession();
        let saved;
        try {
            await session.withTransaction(async () => {
                const records = await outbound.find({ loads: { $elemMatch: selector } }, { loads: 1, poNumber: 1 }).session(session).lean();
                const loads = records.flatMap(record => record.loads.filter(load => loadNumber ? load.loadNumber === loadNumber : load.shipmentId === shipmentId && !load.loadNumber));
                if (!loads.length) throw new Error('signaturePad.bolChanged');
                if (shipmentIds && (!Array.isArray(shipmentIds) || !shipmentIds.length || shipmentIds.some(id => !loads.some(load => load.shipmentId === id)))) throw new Error('Invalid BOL shipment selection');
                const document = await bolDocument.findOne(documentSelector).session(session).lean();
                if (documentId !== undefined && documentId !== (document ? String(document._id) : null)) throw new Error('signaturePad.bolChanged');
                if (document && revision !== undefined && document.revision !== revision) throw new Error('signaturePad.bolChanged');
                if (loads.some(load => load.bol)) throw new Error('BOL migration is required');
                if (loads.some(load => load.bolId && String(load.bolId) !== String(document?._id))) throw new Error('signaturePad.bolChanged');
                const previous = document?.rawData || {};
                let draft = rawData;
                if (number !== undefined && (draft || document?.rawData)) draft = { ...(draft || document.rawData), bill_of_lading_number: number };
                if (draft !== undefined && !clear) {
                    if (!draft || typeof draft !== 'object' || Array.isArray(draft)) throw new Error('Invalid BOL document');
                    draft = applyBolWorkflow(draft, buildBolWorkflow({ ...document, ...documentSelector }, records));
                    if (previous.shipper_signature_submission_id && ['shipper_signature', 'shipper_signature_date', 'shipper_signature_submission_id', 'shipper_signature_device_id']
                        .some(field => previous[field] !== draft[field])) throw new Error('signaturePad.alreadySigned');
                    if (previous.signature_pad_requires_shipper && !draft.signature_pad_requires_shipper) throw new Error('signaturePad.bolChanged');
                    if (previous.signature_pad_document_id && (previous.signature_pad_document_id !== draft.signature_pad_document_id
                        || previous.signature_pad_source_revision !== draft.signature_pad_source_revision)) throw new Error('signaturePad.bolChanged');
                    if (previous.driver_signature && previous.driver_signature !== draft.driver_signature) throw new Error('signaturePad.alreadySigned');
                    if (loads.some(load => load.status === 'Completed') && (previous.driver_signature || '') !== (draft.driver_signature || '')) throw new Error('signaturePad.bolCompleted');
                    if ((previous.driver_signature_submission_id || '') !== (draft.driver_signature_submission_id || '')) throw new Error('signaturePad.bolChanged');
                }
                const fields = { ...documentSelector };
                if (draft !== undefined) Object.assign(fields, { rawData: draft, number: draft?.bill_of_lading_number || '' });
                if (number !== undefined) fields.number = number;
                if (url !== undefined) Object.assign(fields, { url, uploadedAt: url ? new Date() : null });
                if (clear) Object.assign(fields, { rawData: null, url: null, link: null, uploadedAt: null });
                saved = document
                    ? await bolDocument.findOneAndUpdate({ _id: document._id }, { $set: fields, $inc: { revision: 1 } }, { session, new: true }).lean()
                    : (await bolDocument.create([{ ...fields, revision: 1 }], { session }))[0].toObject();
                // Only creation/assignment touches shipments; later edits write the shared document once.
                if (loads.some(load => !load.bolId)) await outbound.updateMany({ loads: { $elemMatch: { ...selector, bolId: null, status: { $nin: ['Cancelled', 'Canceled', 'Leftover, Reschedule Needed'] } } } },
                    { $set: { 'loads.$[load].bolId': saved._id } }, { session,
                        arrayFilters: [{ ...Object.fromEntries(Object.entries(selector).map(([key, value]) => [`load.${key}`, value])), 'load.bolId': null, 'load.status': { $nin: ['Cancelled', 'Canceled', 'Leftover, Reschedule Needed'] } }] });
                if (clear) await outbound.updateMany({ 'loads.bolId': saved._id }, { $set: { 'loads.$[load].status': 'Picked Up' } },
                    { session, arrayFilters: [{ 'load.bolId': saved._id, 'load.status': 'Completed' }] });
                if (shipmentIds) {
                    await outbound.updateMany({ 'loads.loadNumber': loadNumber }, { $set: { 'loads.$[load].bolId': saved._id, 'loads.$[load].status': 'Completed' } },
                        { session, arrayFilters: [{ 'load.loadNumber': loadNumber, 'load.shipmentId': { $in: shipmentIds } }] });
                    if (shipmentIds.length > 1) await outbound.updateMany({ 'loads.loadNumber': loadNumber },
                        { $set: { 'loads.$[load].bolId': null, 'loads.$[load].status': 'Leftover, Reschedule Needed' } },
                        { session, arrayFilters: [{ 'load.loadNumber': loadNumber, 'load.shipmentId': { $nin: shipmentIds } }] });
                }
            });
        } finally { await session.endSession(); }
        return { ...saved, workflow: (await workflows([saved])).get(String(saved._id)) };
    };
    return { get, sync, save };
};

module.exports = { createBolDocumentService };
