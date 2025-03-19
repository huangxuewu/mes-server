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
    scac: {
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
    pickupGate: {
        type: String,
        default: null
    },
    pickupDate: {
        type: String,
        default: null
    },
    schedulePickupAt: {
        type: Date,
        default: null
    },
    actualPickupAt: {
        type: Date,
        default: null
    },
    onPremisesDate: {
        type: String,
        default: null
    },
    cartons: {
        type: Number,
        default: null
    },
    pallets: {
        type: Number,
        default: null
    },
    weight: {
        type: Number,
        default: null
    },
    commodity: {
        type: String,
        default: null
    },
    status: {
        type: String,
        default: "Pending"
    },
}, {
    timestamps: true
});

module.exports = database.model("shipment", shipmentSchema, "shipment");
