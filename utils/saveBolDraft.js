// A phone can save while an operator still has an older draft open. Read and
// update in one transaction so a whole-draft save cannot erase that signature.
module.exports = async (model, selector, data) => {
    const session = await model.startSession();
    let saved;
    try {
        await session.withTransaction(async () => {
            const records = await model.find({ loads: { $elemMatch: selector } }, { loads: 1 }).session(session).lean();
            const targets = records.flatMap(record => record.loads.filter(load => Object.entries(selector).every(([key, value]) => load[key] === value))
                .map(load => ({ id: record._id, load })));
            if (!targets.length) throw new Error('signaturePad.bolChanged');
            const draft = (Object.hasOwn(data, 'bol') ? data.bol?.rawData : data['bol.rawData']) || {};
            const deleting = !Object.hasOwn(data, 'bol') && data['bol.rawData'] === null && data['bol.url'] === null;
            for (const { id, load } of targets) {
                const previous = load.bol?.rawData || {};
                if (!deleting) {
                    if (previous.driver_signature && previous.driver_signature !== draft.driver_signature) throw new Error('signaturePad.alreadySigned');
                    if (load.status === 'Completed' && (previous.driver_signature || '') !== (draft.driver_signature || '')) throw new Error('signaturePad.bolCompleted');
                    if ((previous.driver_signature_submission_id || '') !== (draft.driver_signature_submission_id || '')) throw new Error('signaturePad.bolChanged');
                }
                const update = Object.fromEntries(Object.entries(data).map(([key, value]) => [`loads.$[target].${key}`, value]));
                if (deleting) {
                    update['loads.$[target].bol.uploadedAt'] = null;
                    if (load.status === 'Completed') update['loads.$[target].status'] = 'Picked Up';
                }
                saved = await model.findOneAndUpdate({ _id: id }, { $set: update },
                    { arrayFilters: [{ 'target.shipmentId': load.shipmentId }], session, new: true });
            }
        });
        return saved;
    } finally { await session.endSession(); }
};
