const summaryProjection = { number: 1, url: 1, link: 1, uploadedAt: 1, revision: 1, loadNumber: 1,
    hasRawData: { $ne: [{ $ifNull: ['$rawData', null] }, null] } };

// Used by list/history aggregations. Full document data is fetched separately.
const outboundBolPipeline = () => [
    { $lookup: { from: 'bolDocument', localField: 'loads.bolId', foreignField: '_id',
        pipeline: [{ $project: summaryProjection }], as: '_bolDocuments' } },
    { $set: { loads: { $map: { input: { $ifNull: ['$loads', []] }, as: 'load', in: {
        $mergeObjects: ['$$load', { bolSummary: { $ifNull: [{ $first: { $filter: { input: '$_bolDocuments', as: 'bol', cond: { $eq: ['$$bol._id', '$$load.bolId'] } } } }, { number: '', url: '', hasRawData: false }] } }],
    } } } } },
    { $unset: ['_bolDocuments', 'loads.bol'] },
];

const attachBolDocuments = async (models, records, { session, full = false } = {}) => {
    const ids = [...new Map(records.flatMap(record => (record?.loads || []).filter(load => load.bolId).map(load => [String(load.bolId), load.bolId]))).values()];
    const documents = ids.length ? await models.bolDocument.aggregate([
        { $match: { _id: { $in: ids } } }, ...(full ? [] : [{ $project: summaryProjection }]),
    ]).session(session || null) : [];
    const byId = new Map(documents.map(document => [String(document._id), document]));
    return records.map(record => ({ ...record, loads: (record.loads || []).map(load => {
        const { bol: _embedded, ...reference } = load;
        const document = load.bolId ? byId.get(String(load.bolId)) : null;
        const bol = document || {};
        const { rawData, ...metadata } = bol;
        return { ...reference, bolSummary: document ? { ...metadata, hasRawData: bol.hasRawData ?? Boolean(rawData) } : { number: '', url: '', hasRawData: false },
            ...(full ? { bolDocument: document || null } : {}) };
    }) }));
};

// Resolve references from shipment identity; callers never choose document IDs.
const resolveBolReferences = async (models, loads) => {
    const loadNumbers = [...new Set(loads.map(load => load.loadNumber).filter(Boolean))];
    const shipmentIds = loads.filter(load => !load.loadNumber).map(load => load.shipmentId).filter(Boolean);
    const documents = await models.bolDocument.find({ $or: [{ loadNumber: { $in: loadNumbers } },
        { loadNumber: '', shipmentId: { $in: shipmentIds } }] }, { loadNumber: 1, shipmentId: 1, url: 1 }).lean();
    const byLoad = new Map(documents.filter(doc => doc.loadNumber).map(doc => [doc.loadNumber, doc]));
    const byShipment = new Map(documents.filter(doc => !doc.loadNumber).map(doc => [doc.shipmentId, doc]));
    for (const load of loads) {
        if (Object.hasOwn(load, 'bol')) throw new Error('Shipment updates accept BOL references only');
        delete load.bolSummary;
        const document = load.loadNumber ? byLoad.get(load.loadNumber) : byShipment.get(load.shipmentId);
        if (document || Object.hasOwn(load, 'bolId')) load.bolId = ['Cancelled', 'Canceled', 'Leftover, Reschedule Needed'].includes(load.status) ? null : document?._id || null;
        if (load.bolId && document.url) load.status = 'Completed';
    }
};

module.exports = { summaryProjection, outboundBolPipeline, attachBolDocuments, resolveBolReferences };
