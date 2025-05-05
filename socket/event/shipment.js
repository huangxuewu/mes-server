const db = require("../../models");

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

    // updates shipment regarless of status
    socket.on("shipment:update", async (data, callback) => {
        try {

        } catch (error) {
            callback({ status: "error", message: error.message })
        }
    })

    socket.on("shipment:replace", async (payload, callback) => {
        const { _id, ...data } = payload;

        try {
            // ignore if shipment is completed
            const shipment = await db.shipment.findOneAndUpdate({ _id, status: { $ne: 'Completed' } }, { $set: data }, { new: true });

            // update order status if shipment is picked up
            await db.order.updateShipmentStatus(data);

            callback?.({ status: "success", message: "Shipment updated successfully", payload: shipment });
        } catch (error) {
            callback?.({ status: "error", message: error.message });
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

    socket.on("shipment:get", async (query, callback) => {
        try {
            db.shipment.findOne(query).then(shipment => {
                callback({ status: "success", message: "Shipment fetched successfully", payload: shipment })
            }).catch(error => {
                callback({ status: "error", message: error.message })
            })
        } catch (error) {
            callback({ status: "error", message: error.message })
        }
    })

    socket.on("shipments:get", async (query, callback) => {
        try {
            db.shipment.find(query).then(shipments => {
                callback({ status: "success", message: "Shipments fetched successfully", payload: shipments })
            }).catch(error => {
                callback({ status: "error", message: error.message })
            })
        } catch (error) {
            callback({ status: "error", message: error.message })
        }
    });

    socket.on("shipments:replace", async (payload, callback) => {
        const { loadNumber, ...data } = payload;

        try {
            await db.shipment.updateMany({ loadNumber }, { $set: data });
            await db.order.updateShipmentStatus(data);

            const shipments = await db.shipment.find({ loadNumber });

            callback?.({ status: "success", message: "Shipments updated successfully", payload: shipments });
        } catch (error) {
            callback?.({ status: "error", message: error.message });
        }
    });

    socket.on("shipments:update", async (payload, callback) => {
        try {
            const { masterPO, ...data } = payload;

            await db.shipment.updateMany({ masterPO }, { $set: data });

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

    socket.on("loads:update", async (payload, callback) => {
        try {
            const { loadNumber, note, operator, ...data } = payload;

            note?.length
                ? await db.shipment.updateMany({ loadNumber }, { $set: data, $push: { memos: { content: note, createdAt: new Date, createdBy: operator } } })
                : await db.shipment.updateMany({ loadNumber }, { $set: data });

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