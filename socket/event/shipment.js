const db = require("../../models");
const mongoose = require("mongoose");
const { Types: { ObjectId } } = mongoose;
const { performance } = require('node:perf_hooks');

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
                Object.assign(acc, { [`loads.$[target].${key}`]: data[key] })
                , {});

            await db.shipment.updateOne({ 'loads.shipmentId': shipmentId }, { $set: update }, { arrayFilters: [{ 'target.shipmentId': shipmentId }] });

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
            if (!Array.isArray(payloads) || !payloads.length) {
                return callback?.({ status: "error", message: "Invalid or empty payloads" });
            }

            const startTime = performance.now();

            // Fetch only necessary fields and ensure indexes on poNumber and loads.shipmentId
            const last2Month = new Date(Date.now() - 2 * 30 * 24 * 60 * 60 * 1000);
            const shipments = await db.shipment
                .find(
                    {
                        $or: [
                            { 'loads.status': { $ne: 'Completed' } },
                            { 'loads.pickupDate': { $gte: last2Month } }
                        ]
                    },
                    { poNumber: 1, loads: 1, items: 1 } // Projection to reduce data
                )
                .lean();

            // Create a lookup map for shipments
            const shipmentMap = new Map(shipments.map(s => [s.poNumber, s]));

            // Prepare bulk operations
            const bulkOps = [];

            for (const payload of payloads) {
                const { poNumber, load } = payload;
                if (!poNumber || !load?.shipmentId) continue; // Validate input

                const shipment = shipmentMap.get(poNumber);
                if (!shipment) continue;

                const { loads, items } = shipment;
                const loadIndex = loads.findIndex(doc => doc.shipmentId === load.shipmentId);

                // Update or add load
                if (loadIndex !== -1) {
                    loads[loadIndex] = { ...loads[loadIndex], ...load }; // Merge load data
                } else {
                    loads.push(load);
                }

                const loadRef = loads[loadIndex !== -1 ? loadIndex : loads.length - 1];
                if (loadRef.status === 'Completed') continue;

                // Calculate carton count only if necessary
                const shipmentCartonCount = items.reduce((acc, item) => acc + item.quantity / item.casePack, 0);
                if (loadRef.cartons !== shipmentCartonCount) {
                    loadRef.items = getCartonBreakdown(shipment, loadRef.cartons);
                }

                // Update status if BOL exists
                loadRef.status = loadRef.bol?.url ? "Completed" : loadRef.status;

                // Clean up items if empty
                if (!loadRef?.items?.length) delete loadRef.items;

                // Add update operation to bulk
                bulkOps.push({
                    updateOne: {
                        filter: { poNumber },
                        update: { $set: { loads } }
                    }
                });
            }

            // Execute bulk updates if any
            if (bulkOps.length > 0) {
                await db.shipment.bulkWrite(bulkOps);
            }

            const endTime = performance.now();
            const elapsedTimeMs = endTime - startTime;

            console.log(`Load synced successfully in ${elapsedTimeMs.toFixed(2)}ms`);
            callback?.({ status: "success", message: `Load synced successfully in ${elapsedTimeMs.toFixed(2)}ms` });
        } catch (error) {
            console.error("Load Sync Error:", error);
            callback?.({ status: "error", message: error.message });
        }
    });

    const getCartonBreakdown = (shipment, cartons) => {

        // 1. Sort items small to large by carton count
        const shipmentItems = [...shipment.items].sort((a, b) => a.quantity / a.casePack - b.quantity / b.casePack);

        // 2. Calculate remaining items after subtracting already allocated loads
        const remainItems = shipment.loads.reduce((items, load) => {

            if (!load?.items) return items;

            load.items.forEach(item => {
                const index = items.findIndex(i => i.styleCode === item.styleCode && i.quantity > 0);

                if (index === -1) return;

                items[index].quantity -= item.quantity;
            });

            return items;
        }, shipmentItems).filter(item => item.quantity > 0);

        // 3. Allocate items to fit the target carton count
        const result = [];
        let totalCarton = 0;

        for (const item of remainItems) {
            const carton = item.quantity / item.casePack;

            //Target reached, break the loop
            if (totalCarton === cartons) break;

            if (totalCarton + carton <= cartons) {
                result.push(item);
                totalCarton += carton;
            } else {
                const remainingCarton = cartons - totalCarton;

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

    socket.on("dock:fetch", async (callback) => {
        try {
            const docks = await db.dock.find({});
            callback?.({ status: "success", message: "Docks fetched successfully", payload: docks });
        } catch (error) {
            callback?.({ status: "error", message: error.message });
        }
    });

    socket.on("dock:update", async (payload, callback) => {
        try {
            const { _id, ...data } = payload;
            await db.dock.updateOne({ _id }, { $set: data });
            callback?.({ status: "success", message: "Dock updated successfully" });
        } catch (error) {
            callback?.({ status: "error", message: error.message });
        }
    });

    socket.on("hauler:fetch", async (query, callback) => {
        try {
            const haulers = await db.hauler.find(query);
            callback?.({ status: "success", message: "Haulers fetched successfully", payload: haulers });
        } catch (error) {
            callback?.({ status: "error", message: error.message });
        }
    });

    socket.on("hauler:create", async (payload, callback) => {
        try {
            const doc = await db.hauler.create(payload);
            callback?.({ status: "success", message: "Hauler created successfully", payload: doc });
        } catch (error) {
            callback?.({ status: "error", message: error.message });
        }
    });

    socket.on("hauler:update", async (payload, callback) => {
        try {
            const { _id, ...data } = payload;
            await db.hauler.updateOne({ _id }, { $set: data });
            callback?.({ status: "success", message: "Hauler updated successfully" });
        } catch (error) {
            callback?.({ status: "error", message: error.message });
        }
    });

    socket.on("hauler:delete", async (query, callback) => {
        try {
            await db.hauler.deleteOne(query);
            callback?.({ status: "success", message: "Hauler deleted successfully" });
        } catch (error) {
            callback?.({ status: "error", message: error.message });
        }
    });

}