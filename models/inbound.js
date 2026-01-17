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
    source: {
        type: String,
        enum: ["Port", "Local", "Parcel"]
    },
    carrier: {
        type: String,
        default: ""
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
    etaTime: String,
    ataDate: String,
    ataTime: String,
    receivedAt: Date,
    shipmentFrom: String,
    dischargePort: String,
    destination: {
        type: String,
        default: "Down Home"
    },
    items: [itemSchema],
    trackingEvents: {
        type: [trackingEventsSchema],
        default: []
    },
    documents: {
        type: [documentSchema],
        default: []
    },
    status: {
        type: String,
        enum: ["Pending", "In Progress", "In Transit", "Port Discharging", "Completed", "Cancelled", "On Hold","Postponed"],
        default: "Pending",
        description: "Status of the inbound shipment"
    },
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
                io.emit("inbound:update", change.fullDocument);

                break;
            case "delete":
                io.emit("inbound:delete", change.documentKey._id);
                break;
        }
    });

module.exports = Inbound;


