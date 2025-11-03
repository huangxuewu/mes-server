const mongoose = require("mongoose");
const { io } = require("../socket/io");
const database = require("../config/database");

const buyerSchema = new mongoose.Schema({
    poDate: { type: String, required: true },
    masterPO: { type: String, default: null },
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
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', default: null },
    createdAt: { type: Date, default: null },
    startedAt: { type: Date, default: null },
    finishedAt: { type: Date, default: null },
    totalCount: { type: Number, default: 0 },
});

const inspectionSchema = new mongoose.Schema({
    date: { type: Date, default: null },
    note: { type: String, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', default: null },
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
    inspectedAt: { type: Date, default: null },
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

orderSchema.statics.updateShipmentStatus = async function (shipment) {
    const { poNumber, loads } = shipment;

    for (const load of loads) {
        if (!["Picked Up", "Completed"].includes(load.status)) continue;

        // Update buyers to done
        await this.updateMany({ "buyers.poNumber": poNumber }, { $set: { "buyers.$.done": true } });
        
        // Check and update order status for affected orders
        await this.checkOrderStatusByBuyerPO(poNumber);
    }
}

// Helper function to check and update order status
const checkAndUpdateOrderStatus = async function(orderId, Model) {
    const order = await Model.findById(orderId);
    if (order && order.buyers && order.buyers.length > 0) {
        const allDone = order.buyers.every(buyer => buyer.done);
        if (allDone && order.orderStatus !== "Completed") {
            await Model.findByIdAndUpdate(orderId, {
                $set: {
                    orderStatus: "Completed",
                    fulfilledAt: order.fulfilledAt || new Date()
                }
            });
        }
    }
}

// Static method to check and update order status for orders matching a buyer PO number
orderSchema.statics.checkOrderStatusByBuyerPO = async function(poNumber) {
    const affectedOrders = await this.find({ "buyers.poNumber": poNumber });
    for (const order of affectedOrders) {
        await checkAndUpdateOrderStatus(order._id, this);
    }
}

// Pre-save hook (for save() operations)
orderSchema.pre("save", async function (next) {
    // Check if all buyers are done on every save/update
    if (this.buyers && this.buyers.length > 0) {
        const allDone = this.buyers.every(buyer => buyer.done);
        console.log(allDone, this.orderStatus);
        if (allDone && this.orderStatus !== "Completed") {
            this.orderStatus = "Completed";
            if (!this.fulfilledAt) {
                this.fulfilledAt = new Date();
            }
        }
    }

    next();
})

// Post hook for findOneAndUpdate, findByIdAndUpdate
orderSchema.post(['findOneAndUpdate', 'findByIdAndUpdate'], async function (doc) {
    if (doc) await checkAndUpdateOrderStatus(doc._id, this.model);
})

const Order = database.model("order", orderSchema, 'order');

Order.watch([], { fullDocument: "updateLookup" })
    .on("change", (change) => {
        switch (change.operationType) {
            case "insert":
            case "update":
            case "replace":
                io.emit("order:update", change.fullDocument);
                break;
            case "delete":
                io.emit("order:delete", change.documentKey._id);
                break;
        }
    })

module.exports = Order;

