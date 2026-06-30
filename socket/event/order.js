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
            const order = await db.order.findByIdAndUpdate(_id, { $set: data }, { new: true });

            callback?.({ status: "success", message: "Order updated successfully", payload: order })
        } catch (error) {
            callback?.({ status: "error", message: error.message })
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
                { $match: query || {} },
                { $project: { poNumber: 1, shipWindow: 1, buyers: 1 } },
                { $unwind: '$buyers' },
                { $unwind: '$buyers.items' },
                {
                    $project: {
                        _id: 0,
                        poNumber: 1,
                        buyerPo: '$buyers.poNumber',
                        shipStart: '$shipWindow.start',
                        state: '$buyers.state',
                        city: '$buyers.city',
                        name: '$buyers.name',
                        location: '$buyers.location',
                        styleCode: '$buyers.items.styleCode',
                        quantity: { $add: [{ $ifNull: ['$buyers.items.quantity', 0] }, { $ifNull: ['$buyers.items.adjust', 0] }] },
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
