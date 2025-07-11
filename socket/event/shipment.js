const db = require("../../models");
const mongoose = require("mongoose");
const { Types: { ObjectId } } = mongoose;

module.exports = (socket, io) => {

    socket.on("shipment:create", async (data, callback) => {
        try {
            await db.order.updateOne({ _id: data._id }, { $set: { transitAt: new Date, orderStatus: "In Transit" } });
            await db.shipment.create(data.buyers);

            callback({ status: "success", message: "Shipment created successfully" })
        } catch (error) {
            callback({ status: "error", message: error.message })
        }
    })

    // update shipment itself regardless of status
    socket.on("shipment:update", async (payload, callback) => {
        try {
            const { _id, ...data } = payload;

            await db.shipment.updateOne({ _id }, { $set: data });

            callback({ status: "success", message: "Shipment updated successfully" });

        } catch (error) {
            callback({ status: "error", message: error.message })
        }
    })

    socket.on("shipment:delete", async (query, callback) => {
        try {
            await db.shipment.deleteOne(query);
            callback?.({ status: "success", message: "Shipment deleted successfully" });
        } catch (error) {
            callback?.({ status: "error", message: error.message });
        }
    })

    socket.on("shipment:query", async (query, callback) => {
        try {
            const shipment = await db.shipment.findOne(query).lean();

            callback?.({ status: "success", message: "Shipment fetched successfully", payload: shipment });
        } catch (error) {
            callback?.({ status: "error", message: error.message });
        }
    })

    // socket.on("shipment:get", async (query, callback) => {
    //     try {
    //         //return shipment it self
    //         const shipment = await db.shipment.findOne(query).lean();

    //         callback({ status: "success", message: "Shipment fetched successfully", payload: shipment });
    //     } catch (error) {
    //         callback({ status: "error", message: error.message })
    //     }
    // })

    socket.on("shipments:update", async (payload, callback) => {
        try {

        } catch (error) {
            callback?.({ status: "error", message: error.message });
        }
    })

    socket.on("shipments:complete", async (payload, callback) => {
        try {
            const { masterPO, ...data } = payload;

            const update = Object.keys(data).reduce((acc, key) =>
                Object.assign(acc, { [`loads.$[].${key}`]: data[key] })
                , {});

            await db.shipment.updateMany({ masterPO }, { $set: update }); // [] update all loads

            callback?.({ status: "success", message: "Shipments updated successfully" });

            // update order status
            // if all shipments are completed, update order status to completed
            const shipments = await db.shipment.find({ masterPO });
            const allCompleted = shipments.every(shipment => shipment.status === "Completed" || shipment.bol.link);

            if (!allCompleted) return;

            await db.order.updateOne({ poNumber: masterPO }, { $set: { orderStatus: "Completed", 'buyers.$[].done': true } });

        } catch (error) {
            callback?.({ status: "error", message: error.message });
        }
    })

    socket.on("load:update", async (payload, callback) => {
        try {
            const { shipmentId, ...data } = payload;

            const update = Object.keys(data).reduce((acc, key) =>
                Object.assign(acc, { [`loads.$.${key}`]: data[key] })
                , {});

            await db.shipment.updateOne({ 'loads.shipmentId': shipmentId }, { $set: update });

            callback?.({ status: "success", message: "Load updated successfully" });
        } catch (error) {
            callback?.({ status: "error", message: error.message });
        }
    });

    socket.on("load:add", async (payload, callback) => {
        try {
            const { _id, load } = payload;

            await db.shipment.updateOne({ _id }, { $push: { loads: load } });

            callback?.({ status: "success", message: "Load added successfully" });
        } catch (error) {
            callback?.({ status: "error", message: error.message });
        }
    })

    // only update shipment that is not completed
    socket.on("load:replace", async (payload, callback) => {
        const { _id, load } = payload;

        try {
            load.status = load.bol?.url ? "Completed" : load.status;

            const update = Object.keys(load).reduce((acc, key) =>
                Object.assign(acc, { [`loads.$[elem].${key}`]: load[key] })
                , {});

            // ignore if shipment is completed
            const shipment = await db.shipment.findOneAndUpdate(
                { _id },
                { $set: update },
                { arrayFilters: [{ 'elem.shipmentId': load.shipmentId }], new: true }
            );

            callback?.({ status: "success", message: "Shipment updated successfully", payload: shipment });

            // update order status if shipment is picked up
            if (['Picked Up', 'Completed'].includes(load.status))
                db.order.updateShipmentStatus(shipment);

        } catch (error) {
            callback?.({ status: "error", message: error.message });
        }
    });

    socket.on("load:sync", async (payloads, callback) => {
        try {

            const result = {
                create: [],
                update: [],
            }

            for (const payload of payloads) {
                const { poNumber, load } = payload;

                const shipment = await db.shipment.findOne({ poNumber }).lean();

                if (!shipment) continue;
                // //check if load is already in shipment
                const index = shipment.loads.findIndex(l => l.shipmentId === load.shipmentId);
                const totalCartonCount = shipment.items.reduce((acc, item) => acc + item.quantity / item.casePack, 0);
                const cartonMismatch = load.cartons !== totalCartonCount;

                if (cartonMismatch) {
                    load.items = getCartonBreakdown(shipment, load.cartons);
                }

                index === -1
                    ? shipment.loads.push(load)
                    : Object.assign(shipment.loads[index], load);

                await db.shipment.updateOne({ poNumber }, { $set: { loads: shipment.loads } });
            }

            callback?.({ status: "success", message: "Load synced successfully" });
        } catch (error) {
            callback?.({ status: "error", message: error.message });
        }
    });

    const getCartonBreakdown = (shipment, cartons) => {
        const shipmentItems = [...shipment.items].sort((a, b) => a.quantity / a.casePack - b.quantity / b.casePack);

        const remainItems = shipment.loads.reduce((items, load) => {
            if (!load?.items) return items;

            load.items.forEach(item => {
                const index = items.findIndex(i => i.item === item.item && i.quantity > 0);

                if (index === -1) return;

                items[index].quantity -= item.quantity;
            });

            return items;

        }, shipmentItems).filter(item => item.quantity > 0);

        const result = [];
        let totalCarton = 0;

        for (const item of remainItems) {
            const carton = item.quantity / item.casePack;

            if (totalCarton === cartons) break;

            if (totalCarton + carton <= cartons) {
                result.push(item);
                totalCarton += carton;
            } else {
                const remainingCarton = Math.min(cartons - totalCarton, item.quantity / item.casePack);
                result.push({
                    ...item,
                    quantity: remainingCarton * item.casePack
                });
                totalCarton += remainingCarton;
            }
        }

        return result;
    }

    socket.on("loads:query", async (query, callback) => {
        // hack query if it contains _id, since the mongoose is not auto converting it to object id
        if (query._id) query._id = new ObjectId(query._id);

        query.$or?.forEach(condition => {
            if (condition.schedulePickupAt?.$gte) {
                condition.schedulePickupAt.$gte = new Date(condition.schedulePickupAt.$gte);
            }
            // Handle nested $or conditions
            condition.$or?.forEach(nestedCondition => {
                if (nestedCondition.schedulePickupAt?.$gte) {
                    nestedCondition.schedulePickupAt.$gte = new Date(nestedCondition.schedulePickupAt.$gte);
                }
            });
        });

        try {
            const shipments = await db.shipment.aggregate([
                { $unwind: { path: "$loads", preserveNullAndEmptyArrays: true } },
                { $replaceRoot: { newRoot: { $mergeObjects: ["$$ROOT", "$loads"] } } },
                { $project: { loads: 0 } },
                { $match: query }
            ]);

            callback({ status: "success", message: "Shipments fetched successfully", payload: shipments });
        } catch (error) {
            callback({ status: "error", message: error.message })
        }
    });

    socket.on("loads:update", async (payload, callback) => {
        try {
            const { loadNumber, note, operator, ...data } = payload;
            const update = Object.keys(data).reduce((acc, key) => Object.assign(acc, { [`loads.$.${key}`]: data[key] }), {});

            // note?.length
            //     ? await db.shipment.updateMany({ 'loads.loadNumber': loadNumber }, { $set: update, $push: { memos: { content: note, createdAt: new Date, createdBy: operator } } })
            //     : 
            await db.shipment.updateMany({ 'loads.loadNumber': loadNumber }, { $set: update });

            callback?.({ status: "success", message: "Loads updated successfully" });

        } catch (error) {
            callback?.({ status: "error", message: error.message });
        }
    });

    socket.on("loads:breakdown:update", async (payload, callback) => {
        try {
            const { loadNumber, breakdown } = payload;

            for (const [poNumber, { items }] of Object.entries(breakdown)) {
                await db.shipment.updateOne(
                    { poNumber },
                    { $set: { 'loads.$[target].items': items } },
                    { arrayFilters: [{ 'target.loadNumber': loadNumber }] }
                );
            }

            callback?.({ status: "success", message: `Breakdown for load ${loadNumber} updated successfully` });

        } catch (error) {
            callback?.({ status: "error", message: error.message });
        }
    });

    // return true if bill of lading already exists
    socket.on("bill-of-lading:check", async (data, callback) => {
        try {
            const { number } = data;
            const shipment = await db.shipment.findOne({ 'bol.number': number });
            const message = shipment ? "Bill of Lading already exists" : "Bill of Lading does not exist";

            callback?.({ status: "success", message, payload: !!shipment });

        } catch (error) {
            callback?.({ status: "error", message: error.message });
        }
    });

    socket.on("bill-of-lading:link", async (payload, callback) => {
        try {
            const { shipmentIdArray, loadNumber, updatedAt, link } = payload;

            await db.shipment.updateMany(
                { 'loads.shipmentId': { $in: shipmentIdArray } },
                {
                    $set: {
                        'loads.$[shipment].bol.url': link,
                        'loads.$[shipment].bol.updatedAt': updatedAt,
                        'loads.$[shipment].status': 'Completed'
                    }
                },
                { arrayFilters: [{ 'shipment.shipmentId': { $in: shipmentIdArray } }] }
            );

            await db.shipment.updateMany(
                { 'loads.loadNumber': loadNumber, 'loads.shipmentId': { $nin: shipmentIdArray } },
                {
                    $set: {
                        'loads.$[shipment].bol': { number: null, url: null, updatedAt: null, rawData: null },
                        'loads.$[shipment].status': 'Leftover Shipment, Reschedule Needed'
                    }
                },
                {
                    arrayFilters: [{
                        'shipment.loadNumber': loadNumber,
                        'shipment.shipmentId': { $nin: shipmentIdArray }
                    }]
                }
            );

            callback?.({ status: "success", message: "Bill of Lading linked successfully" });
        } catch (error) {
            callback?.({ status: "error", message: error.message });
        }
    });

    socket.on("search:cache", async (callback) => {
        try {

            const results = await Promise.all([
                // First aggregation - unique orders with buyers
                db.order.aggregate([
                    { $project: { _id: 1, buyers: 1 } },
                    { $unwind: { path: "$buyers", preserveNullAndEmptyArrays: true } },
                    { $addFields: { poNumber: '$buyers.poNumber', done: '$buyers.done' } },
                    { $project: { poNumber: 1, done: 1, _id: 1 } }
                ]),

                // Second aggregation - unique load numbers
                db.shipment.aggregate([
                    { $unwind: { path: "$loads", preserveNullAndEmptyArrays: true } },
                    { $replaceRoot: { newRoot: { $mergeObjects: ["$$ROOT", "$loads"] } } },
                    { $project: { loadNumber: 1, status: 1, _id: 1 } },
                    {
                        $group: {
                            _id: "$loadNumber",
                            loadNumber: { $first: "$loadNumber" },
                            status: { $first: "$status" },
                            docId: { $first: "$_id" }
                        }
                    },
                    { $project: { loadNumber: 1, status: 1, _id: "$docId" } }
                ]),

                // Third aggregation - unique BOL numbers
                db.shipment.aggregate([
                    { $unwind: { path: "$loads", preserveNullAndEmptyArrays: true } },
                    { $replaceRoot: { newRoot: { $mergeObjects: ["$$ROOT", "$loads"] } } },
                    { $addFields: { 'bol': { $toString: '$bol.number' } } },
                    { $project: { 'bol': 1, status: 1, _id: 1 } },
                    {
                        $group: {
                            _id: "$bol",
                            status: { $first: "$status" },
                            docId: { $first: "$_id" }
                        }
                    },
                    { $project: { bol: 1, status: 1, _id: "$docId" } }
                ]),
            ]);

            callback?.({ status: "success", message: "Search results fetched successfully", payload: results });
        } catch (error) {
            callback?.({ status: "error", message: "Search failed", error: error.message });
        }
    })
}