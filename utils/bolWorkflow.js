const { getMilestones } = require('./outboundWorkflowState');

const normalizePo = value => String(value || '').trim().toUpperCase();

// Workflow is a live view, separate from the signed/editable BOL draft.
const buildBolWorkflow = (document, records) => {
    const rows = records.flatMap(record => (record.loads || [])
        .filter(load => document.loadNumber ? load.loadNumber === document.loadNumber : load.shipmentId === document.shipmentId)
        .map(load => ({ ...load, poNumber: record.poNumber || '' })));
    const eligible = rows.filter(row => row.status !== 'Cancelled');
    const currentRelease = getMilestones(rows).releaseId;
    const completed = eligible.length > 0 && eligible.every(row => row.status === 'Completed');
    const signature = [...(document.inspectionSignatures || [])].reverse().find(entry => {
        if (!currentRelease && !completed) return false;
        if (currentRelease && entry.submissionId !== currentRelease) return false;
        // Previously closed DCs are excluded from a new release, just as in SignPad.
        const reviewed = currentRelease ? eligible.filter(row => row.status !== 'Completed') : eligible;
        return reviewed.every(row => row.checklist?.inspected?.status === true && row.checklist?.labeled?.status === true
            && new Date(row.checklist.inspected.timestamp || 0) <= new Date(entry.signedAt)
            && new Date(row.checklist.labeled.timestamp || 0) <= new Date(entry.signedAt)
            && entry.shipments?.some(item => item.shipmentId === row.shipmentId && item.poNumber === row.poNumber));
    });
    return { orders: rows.map(row => ({ shipmentId: row.shipmentId, poNumber: row.poNumber,
        inspected: row.status !== 'Cancelled' && row.checklist?.inspected?.status === true,
        loaded: row.status !== 'Cancelled' && row.checklist?.loaded?.status === true })),
        inspectorSignature: signature ? { image: signature.image, signedAt: signature.signedAt } : null };
};

const applyBolWorkflow = (raw, workflow, includeSignature = false) => {
    if (!raw) return raw;
    const { inspector_signature, inspector_signature_date, ...draft } = raw;
    return { ...draft,
        ...(Array.isArray(raw.customer_order_info) ? { customer_order_info: raw.customer_order_info.map(line => {
            const orders = workflow.orders.filter(order => line.shipment_id ? order.shipmentId === line.shipment_id
                : normalizePo(order.poNumber) && [normalizePo(order.poNumber), `062-${normalizePo(order.poNumber)}`].includes(normalizePo(line.customer_order_number)));
            return { ...line, inspected: orders.length > 0 && orders.every(order => order.inspected),
                loaded: orders.length > 0 && orders.every(order => order.loaded) };
        }) } : {}),
        ...(includeSignature && workflow.inspectorSignature ? { inspector_signature: workflow.inspectorSignature.image,
            inspector_signature_date: workflow.inspectorSignature.signedAt } : {}),
    };
};

module.exports = { buildBolWorkflow, applyBolWorkflow };
