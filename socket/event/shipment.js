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

    socket.on("shipment:update", async (data, callback) => {
        try {

        } catch (error) {
            callback({ status: "error", message: error.message })
        }
    })

    socket.on("shipment:replace", async (payload, callback) => {
        const { _id, ...data } = payload;
        
        try {
            await db.shipment.updateOne({ _id }, { $set: data });
            callback?.({ status: "success", message: "Shipment updated successfully" });
        } catch (error) {
            callback?.({ status: "error", message: error.message });
        }
    })

    socket.on("shipment:delete", async (data, callback) => {
        try {

        } catch (error) {
            callback({ status: "error", message: error.message })
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
    })
}