const dayjs = require("dayjs");
const db = require("../../models");
const mongoose = require("mongoose");
const { Types: { ObjectId } } = mongoose;
const { performance } = require('node:perf_hooks');

module.exports = (socket, io) => {

    socket.on("outbound:create", async (data, callback) => {
        try {
            await db.order.updateOne({ _id: data._id }, { $set: { transitAt: new Date, orderStatus: "In Transit" } });
            await db.inbound.create(data.buyers);

            callback({ status: "success", message: "Outbound shipment created successfully" })
        } catch (error) {
            callback({ status: "error", message: error.message })
        }
    })

    // update shipment itself regardless of status
    socket.on("outbound:update", async (payload, callback) => {
        try {
            const { _id, ...data } = payload;

            await db.inbound.updateOne({ _id }, { $set: data });

            callback({ status: "success", message: "Outbound shipment updated successfully" });

        } catch (error) {
            callback({ status: "error", message: error.message })
        }
    })

    socket.on("outbound:delete", async (query, callback) => {
        try {
            await db.inbound.deleteOne(query);
            callback?.({ status: "success", message: "Outbound shipment deleted successfully" });
        } catch (error) {
            callback?.({ status: "error", message: error.message });
        }
    })

    socket.on("outbound:query", async (query, callback) => {
        try {
            const shipment = await db.inbound.findOne(query).lean();

            callback?.({ status: "success", message: "Outbound shipment fetched successfully", payload: shipment });
        } catch (error) {
            callback?.({ status: "error", message: error.message });
        }
    })

    socket.on("outbound:get", async (query, callback) => {
        try {
            const shipments = await db.inbound.find(query).lean();
            callback?.({ status: "success", message: "Outbound shipments fetched successfully", payload: shipments });
        } catch (error) {
            callback?.({ status: "error", message: error.message });
        }
    })


    socket.on("outbound:complete", async (payload, callback) => {
        try {
            const { masterPO, ...data } = payload;

            const update = Object.keys(data).reduce((acc, key) =>
                Object.assign(acc, { [`loads.$[].${key}`]: data[key] })
                , {});

            await db.inbound.updateMany({ masterPO }, { $set: update }); // [] update all loads

            callback?.({ status: "success", message: "Outbound shipments updated successfully" });

            // update order status
            // if all shipments are completed, update order status to completed
            const shipments = await db.inbound.find({ masterPO });
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

            await db.inbound.updateOne({ 'loads.shipmentId': shipmentId }, { $set: update }, { arrayFilters: [{ 'target.shipmentId': shipmentId }] });

            callback?.({ status: "success", message: "Load updated successfully" });
        } catch (error) {
            callback?.({ status: "error", message: error.message });
        }
    });

    socket.on("load:add", async (payload, callback) => {
        try {
            const { _id, load } = payload;

            await db.inbound.updateOne({ _id }, { $push: { loads: load } });

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
            const shipment = await db.inbound.findOneAndUpdate(
                { _id },
                { $set: update },
                { arrayFilters: [{ 'elem.shipmentId': load.shipmentId }], new: true }
            );

            callback?.({ status: "success", message: "Outbound shipment updated successfully", payload: shipment });

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
            const last2Month = dayjs().subtract(2, 'month').format('YYYY-MM-DD');
            const shipments = await db.inbound
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
                // if (loadRef.status === 'Completed') continue;

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
                await db.inbound.bulkWrite(bulkOps);
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
    };

    // socket.on("loads:history", async (query, callback) => {
    //     try {
    //         const loads = await db.inbound.aggregate([
    //             { $unwind: { path: "$loads", preserveNullAndEmptyArrays: true } },
    //             { $replaceRoot: { newRoot: { $mergeObjects: ["$$ROOT", "$loads"] } } },
    //             { $project: { loads: 0 } },
    //             { $match: query }
    //         ]).lean();

    //         callback?.({ status: "success", message: "Loads history fetched successfully", payload: loads });
    //     } catch (error) {
    //         callback?.({ status: "error", message: error.message });
    //     }
    // })

    socket.on("loads:query", async (query, callback) => {
        // hack query if it contains _id, since the mongoose is not auto converting it to object id
        if (query._id) query._id = ObjectId.createFromHexString(query._id);

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
            const shipments = await db.inbound.aggregate([
                { $unwind: { path: "$loads", preserveNullAndEmptyArrays: true } },
                { $replaceRoot: { newRoot: { $mergeObjects: ["$$ROOT", "$loads"] } } },
                { $project: { loads: 0 } },
                { $match: query }
            ]);

            callback({ status: "success", message: "Outbound shipments fetched successfully", payload: shipments });
        } catch (error) {
            callback({ status: "error", message: error.message })
        }
    });

    socket.on("loads:update", async (payload, callback) => {
        try {
            const { loadNumber, note, operator, ...data } = payload;
            const update = Object.keys(data).reduce((acc, key) => Object.assign(acc, { [`loads.$.${key}`]: data[key] }), {});

            // note?.length
            //     ? await db.inbound.updateMany({ 'loads.loadNumber': loadNumber }, { $set: update, $push: { memos: { content: note, createdAt: new Date, createdBy: operator } } })
            //     : 
            await db.inbound.updateMany({ 'loads.loadNumber': loadNumber }, { $set: update });

            callback?.({ status: "success", message: "Loads updated successfully" });

        } catch (error) {
            callback?.({ status: "error", message: error.message });
        }
    });

    socket.on("loads:breakdown:update", async (payload, callback) => {
        try {
            const { loadNumber, breakdown } = payload;

            for (const [poNumber, { items }] of Object.entries(breakdown)) {
                await db.inbound.updateOne(
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
            const shipment = await db.inbound.findOne({ 'bol.number': number });
            const message = shipment ? "Bill of Lading already exists" : "Bill of Lading does not exist";

            callback?.({ status: "success", message, payload: !!shipment });

        } catch (error) {
            callback?.({ status: "error", message: error.message });
        }
    });

    socket.on("bill-of-lading:link", async (payload, callback) => {
        try {
            const { shipmentIdArray, loadNumber, updatedAt, link } = payload;

            await db.inbound.updateMany(
                { 'loads.shipmentId': { $in: shipmentIdArray } },
                {
                    $set: {
                        'loads.$[shipment].bol.url': link,
                        'loads.$[shipment].bol.updatedAt': updatedAt || new Date(),
                        'loads.$[shipment].status': 'Completed'
                    }
                },
                { arrayFilters: [{ 'shipment.shipmentId': { $in: shipmentIdArray } }] }
            );

            shipmentIdArray.length > 1 &&
                await db.inbound.updateMany(
                    { 'loads.loadNumber': loadNumber, 'loads.shipmentId': { $nin: shipmentIdArray } },
                    {
                        $set: {
                            'loads.$[shipment].bol': { number: null, url: null, updatedAt: null, rawData: null },
                            'loads.$[shipment].status': 'Leftover, Reschedule Needed'
                        }
                    },
                    {
                        arrayFilters: [{
                            'shipment.loadNumber': loadNumber,
                            'shipment.shipmentId': { $nin: shipmentIdArray }
                        }]
                    }
                );

            // update outbound gate status
            await db.gate.updateOne({ 'truck.loadNumber': loadNumber }, { $set: { 'truck': null, 'status': 'Available' } });
            await db.hauler.updateOne({ loadNumber, 'status': 'Loading' }, { $set: { finishLoadAt: new Date(), status: 'Available' } });

            callback?.({ status: "success", message: "Bill of Lading linked successfully" });
        } catch (error) {
            callback?.({ status: "error", message: error.message });
        }
    });

    socket.on("inbound:get", async (query, callback) => {
        try {
            const inbound = await db.inbound.findOne(query);
            callback?.({ status: "success", message: "Inbound shipment fetched successfully", payload: inbound });
        } catch (error) {
            callback?.({ status: "error", message: error.message });
        }
    });

    socket.on("inbound:create", async (payload, callback) => {
        try {
            const inbound = await db.inbound.create(payload);
            callback?.({ status: "success", message: "Inbound shipment created successfully", payload: inbound });
        } catch (error) {
            callback?.({ status: "error", message: error.message });
        }
    });

    socket.on("inbound:update", async (payload, callback) => {
        try {
            const inbound = await db.inbound.updateOne({ _id: payload._id }, { $set: payload });
            callback?.({ status: "success", message: "Inbound shipment updated successfully", payload: inbound });
        } catch (error) {
            callback?.({ status: "error", message: error.message });
        }
    });

    socket.on("inbound:add_event", async (payload, callback) => {
        try {
            const inbound = await db.inbound.updateOne({ _id: payload._id }, { $push: { trackingEvents: payload } });
            callback?.({ status: "success", message: "Inbound shipment event added successfully", payload: inbound });
        } catch (error) {
            callback?.({ status: "error", message: error.message });
        }
    });

    socket.on("inbound:update_event", async (payload, callback) => {
        try {
            // update existing event
            const inbound = await db.inbound.updateOne({
                _id: payload._id,
                'trackingEvents._id': payload._id
            }, {
                $set: {
                    'trackingEvents.$.note': payload.note,
                    'trackingEvents.$.event': payload.event,
                    'trackingEvents.$.location': payload.location,
                }
            });
            callback?.({ status: "success", message: "Inbound shipment event updated successfully", payload: inbound });
        } catch (error) {
            callback?.({ status: "error", message: error.message });
        }
    });

    socket.on("inbound:add_document", async (payload, callback) => {

        try {
            const inbound = await db.inbound.updateOne({ _id: payload._id }, { $push: { documents: payload } });
            callback?.({ status: "success", message: "Inbound shipment document added successfully", payload: inbound });
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
                db.inbound.aggregate([
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
                db.inbound.aggregate([
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

    socket.on("gate:fetch", async (callback) => {
        try {
            const gates = await db.gate.find({});
            callback?.({ status: "success", message: "Gates fetched successfully", payload: gates });
        } catch (error) {
            callback?.({ status: "error", message: error.message });
        }
    });

    socket.on("gate:update", async (payload, callback) => {
        try {
            const { _id, ...data } = payload;
            await db.gate.updateOne({ _id }, { $set: data });
            callback?.({ status: "success", message: "Gate updated successfully" });
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