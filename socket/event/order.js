const db = require("../../models");

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
                    const storedItemsByPoNumber = new Map(
                        currentOrder.buyers.map(buyer => [buyer.poNumber, buyer.items || []])
                    );

                    data.buyers = data.buyers.map((buyer) => {
                        if (!buyer || Object.prototype.hasOwnProperty.call(buyer, 'items')) return buyer;
                        if (!storedItemsByPoNumber.has(buyer.poNumber)) return buyer;

                        return {
                            ...buyer,
                            items: storedItemsByPoNumber.get(buyer.poNumber)
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

    // Reload order buyers/items from PO Items Export and sync outbound.items (never touch loads)
    socket.on('order:po-update', async (payload, callback) => {
        try {
            const { _id, buyers, items, poDate, cancelDate, shipWindow, client, shipIqSnapshot } = payload;
            if (!_id) throw new Error('Missing order _id');
            if (!Array.isArray(buyers) || !buyers.length) throw new Error('Missing buyers from PO export');

            const existing = await db.order.findById(_id).lean();
            if (!existing) throw new Error('Order not found');

            const masterPO = existing.poNumber;
            const keptPoNumbers = buyers.map(b => b.poNumber).filter(Boolean);

            const update = {
                buyers,
                items: items || {},
            };
            if (poDate !== undefined) update.poDate = poDate;
            if (cancelDate !== undefined) update.cancelDate = cancelDate;
            if (shipWindow !== undefined) update.shipWindow = shipWindow;
            if (client !== undefined) update.client = client;
            if (shipIqSnapshot !== undefined) update.shipIqSnapshot = shipIqSnapshot;

            const order = await db.order.findByIdAndUpdate(_id, { $set: update }, { new: true });

            const existingOutbounds = await db.outbound.find({ masterPO }).lean();
            const hasShipments = existingOutbounds.length > 0;

            if (hasShipments) {
                await db.outbound.deleteMany({
                    masterPO,
                    poNumber: { $nin: keptPoNumbers },
                });

                const outboundByPo = new Map(existingOutbounds.map(o => [o.poNumber, o]));
                const orderClient = client || existing.client || 'Target';

                for (const buyer of buyers) {
                    const header = {
                        masterPO: buyer.masterPO || masterPO,
                        poDate: buyer.poDate,
                        poNumber: buyer.poNumber,
                        client: orderClient,
                        name: buyer.name,
                        address: buyer.address,
                        city: buyer.city,
                        state: buyer.state,
                        zip: buyer.zip,
                        country: buyer.country,
                        shipWindow: buyer.shipWindow,
                        items: (buyer.items || []).map(({ upc, quantity, casePack, styleCode, description }) => ({
                            upc,
                            quantity,
                            casePack,
                            styleCode,
                            description,
                        })),
                    };

                    if (outboundByPo.has(buyer.poNumber)) {
                        await db.outbound.updateOne(
                            { poNumber: buyer.poNumber },
                            {
                                $set: {
                                    masterPO: header.masterPO,
                                    poDate: header.poDate,
                                    client: header.client,
                                    name: header.name,
                                    address: header.address,
                                    city: header.city,
                                    state: header.state,
                                    zip: header.zip,
                                    country: header.country,
                                    shipWindow: header.shipWindow,
                                    items: header.items,
                                },
                            }
                        );
                        continue;
                    }

                    await db.outbound.create(header);
                }
            }

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
