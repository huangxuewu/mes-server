const mongoose = require("mongoose");
const database = require("../config/database");

const itemSchema = new mongoose.Schema({
    upc: String,
    quantity: Number,
    casePack: Number,
    styleCode: String,
    description: String,
});

const shipmentSchema = new mongoose.Schema({
    masterPO: String,
    poNumber: { type: String, required: true },
    poDate: { type: String, default: null },
    bol: {
        number: { type: String, default: null },
        thumbnail: { type: String, default: null },
        url: { type: String, default: null },
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
    bolNumber: {
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
    status: {
        type: String,
        default: "Pending"
    },
}, {
    timestamps: true
});

module.exports = database.model("shipment", shipmentSchema, "shipment");
