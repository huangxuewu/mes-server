const mongoose = require("mongoose");
const database = require("../config/database");

const buyerSchema = new mongoose.Schema({
    poDate: { type: String, required: true },
    poNumber: { type: String, required: true },
    name: String,
    address: String,
    city: String,
    state: String,
    zip: String,
    country: String,
    items: [],
    shipWindow: {
        start: String,
        end: String
    }
});

const orderSchema = new mongoose.Schema({
    poDate: { type: String, required: true },
    poNumber: { type: String, required: true },
    cancelDate: { type: String, default: null },
    scheduledAt: { type: Date, default: null },
    inProductionAt: { type: Date, default: null },
    fulfilledAt: { type: Date, default: null },
    transitAt: { type: Date, default: null },
    deliveredAt: { type: Date, default: null },
    invoicedAt: { type: Date, default: null },
    paidAt: { type: Date, default: null },
    creator: { type: mongoose.Schema.Types.ObjectId, ref: 'user', default: null },
    clientId: { type: mongoose.Schema.Types.ObjectId, ref: 'client', default: null },
    client: String,
    orderStatus: { type: String, enum: ['Pending', 'Scheduled', 'In-Progress', 'Completed', 'Cancelled', 'On-Hold'], default: 'Pending' },
    note: String,
    items: {},
    buyers: [buyerSchema],
    priority: {
        type: Number,
        default: 0
    },
    shipWindow: {
        start: String,
        end: String
    },
}, {
    timestamps: true
});

// check if order po number already exists
orderSchema.methods.checkDuplication = async function () {
    const record = await this.constructor.findOne({ poNumber: this.poNumber });

    if (record) throw new Error("Order PO number already exists");
}

module.exports = database.model("order", orderSchema, 'order');

