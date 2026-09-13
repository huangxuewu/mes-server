const db = require("../../models");
const {
    buildOutboundDocument,
    prepareOutboundUpdate,
} = require("../../utils/outboundOrder");

module.exports = (socket, io) => {

    socket.on('order:create', async (data, callback) => {
        try {
            const order = new db.order(data);
            // check if order po number already exists
            await order.checkDuplication();
            await order.save();

            callback?.({ status: "success", message: "Order created successfully", payload: order })
        } catch (error) {
            callback?.({ status: "error", message: error.message })
        }
    });

    socket.on('order:update', async (payload, callback) => {
        try {
            const { _id, ...data } = payload
            if (data.buyers?.length) {
                const currentOrder = await db.order.findById(_id).lean();
                if (currentOrder?.buyers?.length) {
                    const storedBuyersByPoNumber = new Map(
                        currentOrder.buyers.map(buyer => [buyer.poNumber, buyer])
                    );

                    data.buyers = data.buyers.map((buyer) => {
                        const stored = storedBuyersByPoNumber.get(buyer?.poNumber);
                        if (!stored) return buyer;

                        return {
                            ...stored,
                            ...buyer,
                            items: Object.prototype.hasOwnProperty.call(buyer, 'items') ? buyer.items : (stored.items || [])
                        };
                    });
                }
            }

            const order = await db.order.findByIdAndUpdate(_id, { $set: data }, { new: true });

            callback?.({ status: "success", message: "Order updated successfully", payload: order })
        } catch (error) {
            callback?.({ status: "error", message: error.message })
        }
    });

    // Reload the ERP-backed PO while protecting physical shipment allocations.
    socket.on('order:po-update', async (payload, callback) => {
        try {
            const { _id, buyers, items, poDate, cancelDate, shipWindow, client, shipIqSnapshot } = payload;
            if (!_id) throw new Error('Missing order _id');
            if (!Array.isArray(buyers) || !buyers.length) throw new Error('Missing buyers from PO export');
            for (const buyer of buyers) {
                const missingFields = ['address', 'city', 'state', 'zip', 'country']
                    .filter(field => !String(buyer?.[field] ?? '').trim());
                if (missingFields.length)
                    throw new Error(`PO ${buyer?.poNumber || 'unknown'} has an incomplete DC address (${missingFields.join(', ')}). PO update was stopped to protect the saved address.`);
            }

            const existing = await db.order.findById(_id).lean();
            if (!existing) throw new Error('Order not found');

            const masterPO = existing.poNumber;
            const buyersByPo = new Map(buyers.map(buyer => [buyer.poNumber, buyer]));

            const update = {
                buyers,
                items: items || {},
            };
            if (poDate !== undefined) update.poDate = poDate;
            if (cancelDate !== undefined) update.cancelDate = cancelDate;
            if (shipWindow !== undefined) update.shipWindow = shipWindow;
            if (client !== undefined) update.client = client;
            if (shipIqSnapshot !== undefined) update.shipIqSnapshot = shipIqSnapshot;

            const existingOutbounds = await db.outbound.find({ masterPO }).lean();
            const hasShipments = existingOutbounds.length > 0;
            const outboundByPo = new Map(existingOutbounds.map(outbound => [outbound.poNumber, outbound]));
            const nextOrder = { ...existing, ...update };
            const outboundOperations = [];
            const removableOutboundIds = [];

            if (hasShipments) {
                for (const outbound of existingOutbounds) {
                    const buyer = buyersByPo.get(outbound.poNumber);
                    if (!buyer) {
                        if (outbound.loads?.length)
                            throw new Error(`PO-DC ${outbound.poNumber} was removed in ERP but already has a shipment load. Reconcile it before updating the PO.`);
                        removableOutboundIds.push(outbound._id);
                        continue;
                    }

                    const outboundUpdate = prepareOutboundUpdate(nextOrder, buyer, outbound);

                    outboundOperations.push({
                        updateOne: {
                            filter: { _id: outbound._id },
                            update: { $set: outboundUpdate },
                        },
                    });
                }
            }

            const newOutboundDocuments = hasShipments
                ? buyers
                    .filter(buyer => !outboundByPo.has(buyer.poNumber))
                    .map(buyer => buildOutboundDocument(nextOrder, buyer))
                : [];
            const order = await db.order.findByIdAndUpdate(_id, { $set: update }, { new: true });

            if (removableOutboundIds.length)
                await db.outbound.deleteMany({ _id: { $in: removableOutboundIds } });
            if (outboundOperations.length)
                await db.outbound.bulkWrite(outboundOperations);
            if (newOutboundDocuments.length)
                await db.outbound.create(newOutboundDocuments);

            callback?.({
                status: 'success',
                message: 'Order updated from PO export successfully',
                payload: order,
            });
        } catch (error) {
            callback?.({ status: 'error', message: error.message });
        }
    });

    socket.on('order:delete', async (data, callback) => {
        try {
            const order = await db.order.findOneAndDelete(data);
            await db.outbound.deleteMany({ masterPO: order.poNumber });

            callback?.({ status: "success", message: "Order deleted successfully" })
        } catch (error) {
            callback?.({ status: "error", message: error.message })
        }
    });

    socket.on('order:get', async (data, callback) => {
        try {
            const order = await db.order.findOne(data).lean();
            callback?.({ status: "success", message: "Order fetched successfully", payload: order });
        } catch (error) {
            callback?.({ status: "error", message: error.message })
        }
    });

    socket.on('orders:demand', async (query, callback) => {
        try {
            const lines = await db.order.aggregate([
                { $match: query },
                { $project: { poNumber: 1, orderStatus: 1, shipWindow: 1, buyers: 1 } },
                { $unwind: '$buyers' },
                { $unwind: '$buyers.items' },
                {
                    $project: {
                        _id: 0,
                        poNumber: 1,
                        orderStatus: 1,
                        buyerPo: '$buyers.poNumber',
                        buyerStatus: '$buyers.status',
                        buyerDone: '$buyers.done',
                        shipStart: '$shipWindow.start',
                        buyerShipStart: { $ifNull: ['$buyers.shipWindow.start', '$shipWindow.start'] },
                        state: '$buyers.state',
                        city: '$buyers.city',
                        name: '$buyers.name',
                        location: '$buyers.location',
                        styleCode: '$buyers.items.styleCode',
                        quantity: '$buyers.items.quantity',
                        adjust: '$buyers.items.adjust',
                        casePack: '$buyers.items.casePack',
                    }
                },
            ]);

            callback?.({ status: "success", message: "Order demand fetched successfully", payload: lines });
        } catch (error) {
            callback?.({ status: "error", message: error.message })
        }
    });

    socket.on('orders:get', async (query, callback) => {
        try {
            const startedAt = Date.now();
            const orders = await db.order.aggregate([
                { $match: query },
                { $sort: { cancelDate: 1 } },
                {
                    $addFields: {
                        buyers: {
                            $map: {
                                input: { $ifNull: ['$buyers', []] },
                                as: 'buyer',
                                in: {
                                    poNumber: '$$buyer.poNumber',
                                    poDate: '$$buyer.poDate',
                                    masterPO: '$$buyer.masterPO',
                                    name: '$$buyer.name',
                                    address: '$$buyer.address',
                                    city: '$$buyer.city',
                                    state: '$$buyer.state',
                                    zip: '$$buyer.zip',
                                    country: '$$buyer.country',
                                    done: '$$buyer.done',
                                    status: '$$buyer.status',
                                    shipWindow: '$$buyer.shipWindow',
                                }
                            }
                        }
                    }
                },
                { $project: { productionLogs: 0 } },
            ]);
            console.log(`orders:get returned ${orders.length} orders in ${Date.now() - startedAt}ms`);
            callback?.({ status: "success", message: "Orders fetched successfully", payload: orders });
        } catch (error) {
            callback?.({ status: "error", message: error.message })
        }
    });
}
