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
    type: { type: String, default: 'Note', enum: ['Note', 'Reschedule'] },
    content: { type: String, default: null },
    createdAt: { type: Date, default: null },
    createdBy: { type: String, default: null },
});

const shipmentSchema = new mongoose.Schema({
    masterPO: String,
    poNumber: { type: String, required: true },
    poDate: { type: String, default: null },
    bol: {
        number: { type: String, default: null },
        thumbnail: { type: String, default: null },
        url: { type: String, default: null },
        uploadedAt: { type: Date, default: null },
        rawData: { type: Object, default: null },
    },
    name: String,
    address: String,
    city: String,
    state: String,
    zip: String,
    country: String,
    items: [itemSchema],
    shipWindow: {
        start: String,
        end: String
    },
    shipmentId: {
        type: String,
        default: null
    },
    assignedSCAC: {
        type: String,
        default: null
    },
    executingSCAC: {
        type: String,
        default: null
    },
    carrier: {
        type: String,
        default: null
    },
    loadNumber: {
        type: String,
        default: null
    },
    proNumber: {
        type: String,
        default: null
    },
    chRobinsonNumber: {
        type: String,
        default: null
    },
    pickupGate: {
        type: String,
        default: null
    },
    shipDate: {
        type: String,
        default: null,
        description: "Date system originally scheduled for shipment"
    },
    pickupDate: {
        type: String,
        default: null,
        description: "Date system scheduled for pickup"
    },
    schedulePickupAt: {
        type: Date,
        default: null,
        description: "Date we & dispatch scheduled for pickup"
    },
    actualPickupAt: {
        type: Date,
        default: null,
        description: "Date we actually shipped the shipment"
    },
    onPremisesDate: {
        type: String,
        default: null,
        description: "Date that the buyer expected the shipment to be on their premises"
    },
    cartons: {
        type: Number,
        default: null,
        description: "Number of cartons in the shipment"
    },
    pallets: {
        type: Number,
        default: null,
        description: "Number of pallets in the shipment"
    },
    weight: {
        type: Number,
        default: null,
        description: "Weight of the shipment"
    },
    commodity: {
        type: String,
        default: null,
        description: "Commodity of the shipment"
    },
    staging: {
        area: { type: String, default: null },
        ready: { type: Boolean, default: false },
        readyAt: { type: Date, default: null },
    },
    memos: [memoSchema],
    status: {
        type: String,
        default: "Pending"
    },
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
                io.emit("update:shipment", change.fullDocument);

                break;
            case "delete":

                break;
        }
    })

module.exports = Shipment;


