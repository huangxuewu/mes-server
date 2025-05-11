const db = require("../../models");
const mongoose = require("mongoose");

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

    // only update shipment that is not completed
    socket.on("load:replace", async (payload, callback) => {
        const { _id, loads } = payload;

        try {
            for (const load of loads) {
                const update = Object.keys(load).reduce((acc, key) =>
                    Object.assign(acc, { [`loads.$[elem].${key}`]: load[key] })
                    , {});

                // ignore if shipment is completed
                const shipment = await db.shipment.findOneAndUpdate(
                    { _id },
                    { $set: update },
                    { arrayFilters: [{ 'elem.status': { $ne: 'Completed' } }], new: true }
                );

                callback?.({ status: "success", message: "Shipment updated successfully", payload: shipment });

                // update order status if shipment is picked up
                if (['Picked Up', 'Completed'].includes(load.status))
                    db.order.updateShipmentStatus(shipment);
            }

        } catch (error) {
            callback?.({ status: "error", message: error.message });
        }
    });

    socket.on("loads:query", async (query, callback) => {
        // hack query if it contains _id, since the mongoose is not auto converting it to object id
        if (query._id) query._id = new mongoose.Types.ObjectId(query._id);

        try {
            const shipments = await db.shipment.aggregate([
                { $unwind: "$loads" },
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

            const update = Object.keys(data).reduce((acc, key) =>
                Object.assign(acc, { [`loads.$.${key}`]: data[key] })
                , {});

            note?.length
                ? await db.shipment.updateMany({ 'loads.loadNumber': loadNumber }, { $set: update, $push: { memos: { content: note, createdAt: new Date, createdBy: operator } } })
                : await db.shipment.updateMany({ 'loads.loadNumber': loadNumber }, { $set: update });

            callback?.({ status: "success", message: "Loads updated successfully" });

        } catch (error) {
            callback?.({ status: "error", message: error.message });
        }
    })

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
    })
}