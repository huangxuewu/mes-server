const mongoose = require("mongoose");
const database = require("../config/database");
const { io } = require("../socket/io");

const invoiceSchema = new mongoose.Schema({
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
    invoiceUrl: {
        type: String,
        default: "",
        trim: true,
    },
}, {
    timestamps: true,
});

invoiceSchema.index({ periodStart: -1, provider: 1 });
invoiceSchema.index({ status: 1, periodEnd: -1 });
invoiceSchema.index({ providerId: 1, periodStart: -1 });

const Invoice = database.model("invoice", invoiceSchema, "invoice");

Invoice.watch([], { fullDocument: "updateLookup" })
    .on("change", (change) => {
        switch (change.operationType) {
            case "insert":
            case "update":
            case "replace":
                io.emit("invoice:update", change.fullDocument);
                break;
            case "delete":
                io.emit("invoice:delete", change.documentKey._id);
                break;
        }
    });

module.exports = Invoice;
