const mongoose = require("mongoose");
const { io } = require("../socket/io");
const database = require("../config/database");

const itemSchema = new mongoose.Schema({
    upc: String,
    quantity: Number,
    casePack: Number,
    styleCode: String,
    description: String,
});

const memoSchema = new mongoose.Schema({
    content: { type: String, default: null },
    createdAt: { type: Date, default: null },
    createdBy: { type: String, default: null },
});

const loadSchema = new mongoose.Schema({
    pickupDate: { type: String, default: null, description: "Date Ship IQ assigned for pickup" },
    pickupGate: { type: String, default: null, description: "Gate code for pickup" },
    onPremisesDate: { type: String, default: null, description: "Date buyer expected shipment to be on their premises" },
    schedulePickupAt: { type: Date, default: null, description: "Date carrier scheduled for pickup" },
    actualPickupAt: { type: Date, default: null, description: "Date carrier actually came to pickup the shipment" },
    shipmentId: { type: String, default: "" },
    loadNumber: { type: String, default: "" },
    proNumber: { type: String, default: "" },
    assignedSCAC: { type: String, default: "" },
    executingSCAC: { type: String, default: "" },
    chRobinsonNumber: { type: String, default: "" },
    weight: { type: Number, default: 0 },
    cartons: { type: Number, default: 0 },
    pallets: { type: Number, default: 0 },
    commodity: { type: String, default: "" },
    status: { type: String, default: "Pending" },
    bol: {
        number: { type: String, default: null },
        url: { type: String, default: null },
        uploadedAt: { type: Date, default: null },
        rawData: { type: Object, default: null },
    },
    checklist: {
        printed: {
            status: { type: Boolean, default: false, description: "Whether the shipping labels are printed" },
            timestamp: { type: Date, default: null },
        },
        picked: {
            status: { type: Boolean, default: false, description: "Whether all the boxes are picked and ready to be labeled" },
            timestamp: { type: Date, default: null },
        },
        labeled: {
            status: { type: Boolean, default: false, description: "Whether all the boxes are labeled" },
            timestamp: { type: Date, default: null },
        },
        loading: {
            status: { type: Boolean, default: false, description: "Whether the truck is here and shipment is loading" },
            timestamp: { type: Date, default: null },
        },
        loaded: {
            status: { type: Boolean, default: false, description: "Whether the shipment is completely loaded on the truck" },
            timestamp: { type: Date, default: null },
        },
    }
}, { _id: false, timestamps: true });

const shipmentSchema = new mongoose.Schema({
    masterPO: String,
    poNumber: { type: String, required: true },
    poDate: { type: String, default: null },
    client: { type: String, default: "Target" },
    name: String,
    address: String,
    city: String,
    state: String,
    zip: String,
    country: String,
    items: [itemSchema],
    loads: [loadSchema],
    shipWindow: {
        start: String,
        end: String
    },
    memos: [memoSchema],
}, {
    timestamps: true
});

const Shipment = database.model("shipment", shipmentSchema, "shipment");

Shipment.createIndexes({
    "masterPO": 1,
    "poNumber": 1,
});

Shipment
    .watch([], { fullDocument: "updateLookup" })
    .on("change", (change) => {
        switch (change.operationType) {
            case "insert":
            case "update":
            case "replace":
                io.emit("shipment:update", change.fullDocument);

                break;
            case "delete":
                io.emit("shipment:delete", change.documentKey._id);
                break;
        }
    });

module.exports = Shipment;


