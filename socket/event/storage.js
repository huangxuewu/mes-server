const db = require("../../models");

const palletUnits = p => (p.boxesPerPallet || 0) * (p.bagsPerBox || 0) * (p.pillowsPerBag || 0);

const formatLocation = l => [l?.zone, l?.aisle, l?.rack, l?.level, l?.position]
    .filter(v => v !== undefined && v !== null && v !== '')
    .join(' / ');

module.exports = (socket, io) => {

    socket.on("storages:get", async (query = {}, callback) => {
        try {
            const storages = await db.storage.find(query).sort({ createdAt: -1 });
            callback({ status: "success", message: "Storage records fetched successfully", payload: storages });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    // Phase 1 — place the pallet into a location. No inventory impact.
    socket.on("pallet:store", async (payload, callback) => {
        try {
            const { palletId, location, by } = payload;
            if (!palletId || !location?.zone) return callback({ status: "error", message: "Missing palletId or location" });

            const pallet = await db.pallet.findById(palletId);
            if (!pallet) return callback({ status: "error", message: "Pallet not found" });
            if (pallet.status === 'Putaway') return callback({ status: "error", message: "Pallet already putaway" });

            // batchNumber holds the pallet barcode so putaway can find this record
            const existing = await db.storage.findOne({ batchNumber: pallet._id });
            existing
                ? await db.storage.updateOne({ _id: existing._id }, { $set: { location, "lastMoved.date": new Date(), "lastMoved.by": by } })
                : await db.storage.create({
                    type: 'Pallet',
                    location,
                    contents: [{ inventoryId: pallet.productId, inventoryType: 'finishedGoods', sku: pallet.styleCode, quantity: palletUnits(pallet) }],
                    lotNumber: pallet.lotNumber,
                    batchNumber: pallet._id,
                    receive: { date: new Date(), by }
                });

            pallet.status = 'Stored';
            pallet.trace.push({ date: new Date(), by, action: `Stored at ${formatLocation(location)}` });
            await pallet.save();

            callback({ status: "success", message: "Pallet stored successfully", payload: pallet });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    // Phase 2 — final confirmation: count the pallet into finishedGoods inventory.
    socket.on("pallet:putaway", async (payload, callback) => {
        try {
            const { palletId, location, by } = payload;
            if (!palletId) return callback({ status: "error", message: "Missing palletId" });

            const pallet = await db.pallet.findById(palletId);
            if (!pallet) return callback({ status: "error", message: "Pallet not found" });
            if (pallet.status === 'Putaway') return callback({ status: "error", message: "Pallet already putaway" });

            let storage = await db.storage.findOne({ batchNumber: pallet._id });
            if (!storage && !location?.zone) return callback({ status: "error", message: "Pallet has no storage location — store it first or provide a location" });

            const quantity = palletUnits(pallet);

            let finishedGoods = await db.finishedGoods.findOne({ productId: pallet.productId });
            if (!finishedGoods) finishedGoods = await db.finishedGoods.create({
                productId: pallet.productId,
                styleCode: pallet.styleCode,
                styleName: pallet.productName || pallet.styleCode || 'Unknown',
                category: 'Final Product'
            });

            await finishedGoods.updateStock(quantity, 'add');

            // One-step putaway for a still-Pending pallet: create the storage record now
            if (!storage) {
                storage = await db.storage.create({
                    type: 'Pallet',
                    location,
                    contents: [{ inventoryId: finishedGoods._id, inventoryType: 'finishedGoods', sku: pallet.styleCode, quantity }],
                    lotNumber: pallet.lotNumber,
                    batchNumber: pallet._id,
                    receive: { date: new Date(), by }
                });
            } else {
                // Point contents at the resolved finishedGoods doc (was productId placeholder)
                await db.storage.updateOne(
                    { _id: storage._id },
                    { $set: { "contents.0.inventoryId": finishedGoods._id, "contents.0.quantity": quantity } }
                );
            }

            pallet.status = 'Putaway';
            pallet.trace.push({ date: new Date(), by, action: `Putaway confirmed (${quantity} units)` });
            await pallet.save();

            callback({ status: "success", message: "Putaway confirmed successfully", payload: pallet });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

};
