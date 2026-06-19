const mongoose = require("mongoose");
const database = require("../config/database");
const { io } = require("../socket/io");

const billSchema = new mongoose.Schema({
    providerId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "serviceProvider",
        default: null,
    },
    provider: {
        type: String,
        required: true,
        trim: true,
    },
    category: {
        type: String,
        default: "",
        trim: true,
    },
    accountNumber: {
        type: String,
        default: "",
        trim: true,
    },
    periodStart: {
        type: String,
        required: true,
        trim: true,
    },
    periodEnd: {
        type: String,
        required: true,
        trim: true,
    },
    dueDate: {
        type: String,
        default: "",
        trim: true,
    },
    amount: {
        type: Number,
        required: true,
        min: 0,
    },
    status: {
        type: String,
        enum: ["Paid", "Unpaid", "Overdue"],
        default: "Unpaid",
    },
    note: {
        type: String,
        default: "",
        trim: true,
    },
    billUrl: {
        type: String,
        default: "",
        trim: true,
    },
    billPath: {
        type: String,
        default: "",
        trim: true,
    },
    processDate: {
        type: String,
        default: "",
        trim: true,
    },
    paymentMethod: {
        type: String,
        enum: ["AutoPay", "ACH", "Check", "CreditCard", "Wire", ""],
        default: "",
        trim: true,
    },
    paymentReference: {
        type: String,
        default: "",
        trim: true,
    },
    handler: {
        type: String,
        default: "",
        trim: true,
    },
}, {
    timestamps: true,
});

billSchema.index({ periodStart: -1, provider: 1 });
billSchema.index({ status: 1, periodEnd: -1 });
billSchema.index({ providerId: 1, periodStart: -1 });

const Bill = database.model("bill", billSchema, "bill");

Bill.watch([], { fullDocument: "updateLookup" })
    .on("change", (change) => {
        switch (change.operationType) {
            case "insert":
            case "update":
            case "replace":
                io.emit("bill:update", change.fullDocument);
                break;
            case "delete":
                io.emit("bill:delete", change.documentKey._id);
                break;
        }
    });

module.exports = Bill;
