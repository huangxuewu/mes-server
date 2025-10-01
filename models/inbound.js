const mongoose = require("mongoose");
const { io } = require("../socket/io");
const database = require("../config/database");

const itemSchema = new mongoose.Schema({
    upc: String,
    quantity: Number,
    casePack: Number,
    styleCode: String,
    description: String,
    vendor: String,
}, { _id: false });

const trackingEventsSchema = new mongoose.Schema({
    date: String,
    event: String,
    location: String,
    note: String,
}, { _id: false });

const documentSchema = new mongoose.Schema({
    type: String,
    url: String,
    documentId: { type: mongoose.Schema.Types.ObjectId, ref: "document" },
    formData: mongoose.Schema.Types.Mixed,
}, { _id: false });

const inboundSchema = new mongoose.Schema({
    poNumber: { type: String, required: true },
    poDate: { type: String, default: null },
    shipmentType: {
        type: String,
        enum: ["Overseas", "Domestic"]
    },
    containerNumber: String,
    sealNumber: String,
    vesselNumber: String,
    voyageNumber: String,
    bolNumber: String,
    truckNumber: String,
    deliveryNote: String,
    receiveNote: String,
    shipDate: String,
    etaDate: String,
    ataDate: String,
    receivedAt: Date,
    originPort: String,
    dischargePort: String,
    destination: {
        type: String,
        default: "Down Home"
    },
    items: [itemSchema],
    trackingEvents: [trackingEventsSchema],
    documents: [documentSchema],
}, {
    timestamps: true
});

const Inbound = database.model("inbound", inboundSchema, "inbound");

Inbound.createIndexes({
    "masterPO": 1,
    "poNumber": 1,
});

Inbound
    .watch([], { fullDocument: "updateLookup" })
    .on("change", (change) => {
        switch (change.operationType) {
            case "insert":
            case "update":
            case "replace":
                io.emit("outbound:update", change.fullDocument);

                break;
            case "delete":
                io.emit("outbound:delete", change.documentKey._id);
                break;
        }
    });

Inbound.getActiveLoads = async () => {
    const loads = await Inbound.aggregate([
        { $match: { "loads.status": { $in: ["Carrier Accepted, Awaiting Pickup", "Past Pickup"] } } },
        { $unwind: { path: "$loads", preserveNullAndEmptyArrays: true } },
        { $replaceRoot: { newRoot: { $mergeObjects: ["$$ROOT", "$loads"] } } },
        { $project: { loads: 0 } },
        { $group: { _id: "$loadNumber", loads: { $push: "$$ROOT" } } },
        { $project: { _id: 0, loadNumber: "$_id", loads: 1 } }
    ]);

    return loads;
};

module.exports = Inbound;


