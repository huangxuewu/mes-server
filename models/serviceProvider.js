const mongoose = require("mongoose");
const database = require("../config/database");
const { io } = require("../socket/io");

const FREQUENCIES = ["Monthly", "Quarterly", "Semi-Annual", "Annual", "Custom"];
const PAYMENT_TYPES = ["AutoPay", "ACH", "Check", "CreditCard", "Wire"];
const PAYMENT_TERMS = ["Due on Receipt", "Net 15", "Net 30", "Net 45", "Net 60"];
const EXPENSE_CATEGORIES = [
    "Utilities",
    "Insurance",
    "Facilities",
    "Fuel & Energy",
    "Waste Removal",
    "Communications",
    "Safety & Compliance",
    "Professional Services",
    "Other",
];

const serviceProviderSchema = new mongoose.Schema({
    vendor: {
        type: String,
        required: true,
        trim: true,
    },
    serviceType: {
        type: String,
        required: true,
        trim: true,
    },
    expenseCategory: {
        type: String,
        enum: EXPENSE_CATEGORIES,
        required: true,
        default: "Other",
    },
    frequency: {
        type: String,
        enum: FREQUENCIES,
        default: "Monthly",
    },
    paymentType: {
        type: String,
        enum: PAYMENT_TYPES,
        default: "ACH",
    },
    paymentTerms: {
        type: String,
        enum: PAYMENT_TERMS,
        default: "Net 30",
    },
    servicePhone: {
        type: String,
        default: "",
        trim: true,
    },
    contactEmail: {
        type: String,
        default: "",
        trim: true,
        lowercase: true,
    },
    contactPerson: {
        type: String,
        default: "",
        trim: true,
    },
    contactId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "contact",
        default: null,
    },
    status: {
        type: String,
        enum: ["Active", "Inactive"],
        default: "Active",
    },
    note: {
        type: String,
        default: "",
        trim: true,
    },
}, {
    timestamps: true,
});

serviceProviderSchema.index({ vendor: 1, serviceType: 1 });
serviceProviderSchema.index({ status: 1, expenseCategory: 1 });

const ServiceProvider = database.model("serviceProvider", serviceProviderSchema, "serviceProvider");

ServiceProvider.watch([], { fullDocument: "updateLookup" })
    .on("change", (change) => {
        switch (change.operationType) {
            case "insert":
            case "update":
            case "replace":
                io.emit("serviceProvider:update", change.fullDocument);
                break;
            case "delete":
                io.emit("serviceProvider:delete", change.documentKey._id);
                break;
        }
    });

module.exports = ServiceProvider;
