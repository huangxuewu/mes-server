const db = require('../../models');
const database = require('../../config/database');
const { getActiveSessionUser, hasPermission } = require('../session');

const units = pallet => pallet.quantity ?? pallet.boxesPerPallet * pallet.bagsPerBox * pallet.pillowsPerBag;
const fail = key => { throw new Error('productionPallet.errors.' + key); };
const formatLocation = location => [location?.zone, location?.aisle, location?.rack, location?.level, location?.position]
    .filter(value => value !== undefined && value !== null && value !== '').join(' / ');

module.exports = socket => {
    socket.on('storages:get', async (query = {}, callback) => {
        try { callback({ status: 'success', payload: await db.storage.find(query).sort({ createdAt: -1 }) }); }
        catch (error) { callback({ status: 'error', message: error.message }); }
    });

    for (const action of ['store', 'putaway']) {
        socket.on('pallet:' + action, async (payload = {}, callback) => {
            try {
                const user = await getActiveSessionUser(socket);
                if (!hasPermission(user, 'update', 'inventory.putaway')) fail('permission');
                if (typeof payload.palletId !== 'string') fail('request');
                const result = await database.connection.transaction(async session => {
                    const pallet = await db.pallet.findOneAndUpdate({ _id: payload.palletId }, { $inc: { revision: 1 } }, { new: true, session });
                    if (!pallet || pallet.status === 'Voided') fail('pallet');
                    // A retried putaway acknowledges the original receipt; it never increments stock again.
                    if (pallet.status === 'Putaway') {
                        if (action === 'store') fail('putaway');
                        return pallet;
                    }
                    if (!['Pending', 'Stored'].includes(pallet.status)) fail('pallet');
                    const quantity = units(pallet);
                    if (!Number.isSafeInteger(quantity) || quantity <= 0) fail('quantity');
                    const existing = await db.storage.find({ batchNumber: pallet._id }).limit(2).session(session);
                    if (existing.length > 1) fail('duplicateStorage');
                    let storage = existing[0];
                    const location = payload.location || storage?.location;
                    if (!location?.zone) fail('location');
                    if (action === 'store' && !payload.location?.zone) fail('location');
                    const now = new Date();
                    let inventoryId = pallet.productId;
                    if (action === 'putaway') {
                        // Different pallets of the same product share a lock while resolving/incrementing stock.
                        const product = await db.product.findOneAndUpdate({ _id: pallet.productId }, { $inc: { stockRevision: 1 } }, { new: true, session });
                        if (!product) fail('product');
                        const matches = await db.finishedGoods.find({ productId: pallet.productId }).limit(2).session(session);
                        if (matches.length > 1) fail('duplicateStock');
                        const goods = matches[0] || (await db.finishedGoods.create([{
                            productId: pallet.productId, styleCode: pallet.styleCode,
                            styleName: pallet.productName || pallet.styleCode || 'Unknown', category: 'Final Product',
                            totalQuantity: 0, availableQuantity: 0,
                        }], { session }))[0];
                        inventoryId = goods._id;
                        await db.finishedGoods.updateOne({ _id: goods._id }, { $inc: { totalQuantity: quantity, availableQuantity: quantity } }, { session, runValidators: true });
                    }
                    const contents = [{ inventoryId, inventoryType: 'finishedGoods', sku: pallet.styleCode, quantity }];
                    if (!storage) {
                        [storage] = await db.storage.create([{
                            type: 'Pallet', location, contents, lotNumber: pallet.lotNumber, batchNumber: pallet._id,
                            receive: { date: now, by: user._id },
                        }], { session });
                    } else {
                        storage.location = location; storage.contents = contents;
                        storage.lastMoved = { date: now, by: user._id };
                        await storage.save({ session });
                    }
                    pallet.status = action === 'putaway' ? 'Putaway' : 'Stored';
                    pallet.trace.push({ date: now, by: user._id, action: action === 'putaway' ? 'Putaway confirmed (' + quantity + ' units)' : 'Stored at ' + formatLocation(location) });
                    await pallet.save({ session });
                    return pallet;
                });
                callback({ status: 'success', payload: result });
            } catch (error) { callback({ status: 'error', message: error.message }); }
        });
    }
};
