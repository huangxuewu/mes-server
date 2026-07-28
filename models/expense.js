const mongoose = require("mongoose");
const database = require("../config/database");
const { io } = require("../socket/io");

const decisionHistorySchema = new mongoose.Schema({
    action: {
        type: String,
        enum: ["Submitted", "Approved", "Rejected"],
        required: true,
    },
    at: { type: Date, default: Date.now },
    actor: { type: String, required: true, trim: true },
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        required: true,
    },
    message: { type: String, default: "", trim: true },
}, { _id: false });

const expenseSchema = new mongoose.Schema({
    expenseNumber: { type: String, required: true, unique: true, trim: true },
    vendor: { type: String, required: true, trim: true },
    date: { type: Date, required: true },
    category: { type: String, required: true, trim: true },
    amount: { type: Number, required: true, min: 0.01 },
    projectId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "project",
        default: null,
    },
    projectName: { type: String, default: "", trim: true },
    receiptUrl: { type: String, default: "", trim: true },
    receiptPath: { type: String, default: "", trim: true },
    note: { type: String, default: "", trim: true },
    approvalStatus: {
        type: String,
        enum: ["Pending", "Approved", "Rejected"],
        default: "Pending",
    },
    paymentStatus: {
        type: String,
        enum: ["Unpaid", "Paid"],
        default: "Unpaid",
    },
    decisionHistory: { type: [decisionHistorySchema], default: [] },
    processDate: { type: Date, default: null },
    paymentMethod: { type: String, default: "", trim: true },
    paymentReference: { type: String, default: "", trim: true },
    handler: { type: String, default: "", trim: true },
}, { timestamps: true });

expenseSchema.index({ date: -1, expenseNumber: -1 });
expenseSchema.index({ approvalStatus: 1, date: -1 });
expenseSchema.index({ paymentStatus: 1, date: -1 });
expenseSchema.index({ projectId: 1, date: -1 });

const Expense = database.model("expense", expenseSchema, "expense");

Expense.watch([], { fullDocument: "updateLookup" })
    .on("change", (change) => {
        switch (change.operationType) {
            case "insert":
            case "update":
            case "replace":
                io.emit("expense:update", change.fullDocument);
                break;
            case "delete":
                io.emit("expense:delete", change.documentKey._id);
                break;
        }
    });

module.exports = Expense;
