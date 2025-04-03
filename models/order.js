const mongoose = require("mongoose");
const { io } = require("../socket/io");
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
    },
    done: {
        type: Boolean,
        default: false,
        description: "Shipping status, true when carrier picked up"
    }
});

const productionLogSchema = new mongoose.Schema({
    date: { type: Date, default: null },
    note: { type: String, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'employee', default: null },
    createdAt: { type: Date, default: null },
    startedAt: { type: Date, default: null },
    finishedAt: { type: Date, default: null },
    totalCount: { type: Number, default: 0 },
});

const inspectionSchema = new mongoose.Schema({
    date: { type: Date, default: null },
    note: { type: String, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'employee', default: null },
    createdAt: { type: Date, default: null },
    inspectionType: { type: String, enum: ['Pre-Production', 'In-Production', 'Post-Production'], default: 'Pre-Production' },
    result: { type: String, enum: ['Pass', 'Fail'], default: 'Pass' },
    images: [String],
});

const orderSchema = new mongoose.Schema({
    poDate: { type: String, required: true },
    poNumber: { type: String, required: true },
    cancelDate: { type: String, default: null },
    scheduledAt: { type: Date, default: null },
    inProductionAt: { type: Date, default: null },
    fulfilledAt: { type: Date, default: null },
    transitAt: { type: Date, default: null },
    shippedAt: { type: Date, default: null },
    invoicedAt: { type: Date, default: null },
    paidAt: { type: Date, default: null },
    creator: { type: mongoose.Schema.Types.ObjectId, ref: 'user', default: null },
    clientId: { type: mongoose.Schema.Types.ObjectId, ref: 'client', default: null },
    client: String,
    orderStatus: { type: String, enum: ['Pending', 'Scheduled', 'In-Progress', 'Completed', 'Cancelled', 'On-Hold'], default: 'Pending' },
    note: String,
    items: {},
    buyers: [buyerSchema],
    productionLogs: [productionLogSchema],
    inspections: [inspectionSchema],
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

orderSchema.statics.updateShipmentStatus = async function ({ status, poNumber }) {
    if (status !== "Picked Up") return;

    await this.updateMany({ "buyers.poNumber": poNumber }, { $set: { "buyers.$.done": true } });
}


const Order = database.model("order", orderSchema, 'order');

Order.watch([], { fullDocument: "updateLookup" })
    .on("change", (change) => {

        switch (change.operationType) {
            case "insert":
            case "update":
            case "replace":
                const doc = change?.fullDocument;
                // if order is completed, do not update
                if (doc.orderStatus === "Completed") return io.emit("order:update", doc);

                const allDone = doc.buyers.every(buyer => buyer.done);

                if (allDone) {
                    database.model('order').updateOne({ _id: doc._id }, { orderStatus: "Completed", shippedAt: new Date() }).exec();
                    io.emit("order:update", doc);
                }

                break;
        }

    })

module.exports = Order;

