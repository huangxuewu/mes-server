const mongoose = require("mongoose");
const { io } = require("../socket/io");
const database = require("../config/database");

const itemSchema = new mongoose.Schema({
    materialType: String,
    dimensions: {
        length: Number,
        width: Number,
        height: Number,
        unit: String
    },
    upc: String,
    unit: String,
    quantity: Number,
    casePack: Number,
    styleCode: String,
    styleSize: String,
    styleColor: String,
    description: String,
    prouductName: String,
    supplierName: String,
}, { _id: false });

const trackingEventsSchema = new mongoose.Schema({
    date: String,
    event: String,
    location: String,
    note: String,
}, { _id: false });

const documentSchema = new mongoose.Schema({
    poNumber: String,
    poDate: String,
    note: String,
    items: [itemSchema],
    documentId: { type: mongoose.Schema.Types.ObjectId, ref: "document" },
    formData: mongoose.Schema.Types.Mixed,
    link: String,
})

const inboundSchema = new mongoose.Schema({
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
    documents: [documentSchema],
    trackingEvents: {
        type: [trackingEventsSchema],
        default: []
    },
    status: {
        type: String,
        enum: ["Pending", "In Progress", "In Transit", "Port Discharging", "Completed", "Cancelled", "On Hold", "Postponed"],
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


