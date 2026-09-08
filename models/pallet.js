const mongoose = require("mongoose");
const { io } = require("../socket/io");
const database = require("../config/database");

const traceSchema = new mongoose.Schema({
    date: { type: Date, default: null },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'employee' },
    action: { type: String, default: null },
});

const palletSchema = new mongoose.Schema({
    _id: {
        type: String,
    },
    date: {
        type: String,
    },
    time: {
        type: Date
    },
    lotNumber: {
        type: String,
    },
    category: {
        type: String,
        enum: ['Finished Goods', 'Raw Materials', 'Tools', 'Accessories', 'Other'],
        default: 'Finished Goods',
    },
    productId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Product",
        required: true,
    },
    styleCode: {
        type: String,
    },
    letterCode: {
        type: String,
    },
    productName: {
        type: String,
    },
    boxesPerPallet: {
        type: Number,
    },
    bagsPerBox: {
        type: Number,
    },
    pillowsPerBag: {
        type: Number,
    },
    productionRunId: { type: mongoose.Schema.Types.ObjectId, ref: 'productionRun' },
    lineId: { type: mongoose.Schema.Types.ObjectId, ref: 'line' },
    lineName: String,
    clientName: String,
    timeZone: String,
    registeredAt: Date,
    registeredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'user' },
    registeredByEmployee: { type: mongoose.Schema.Types.ObjectId, ref: 'employee' },
    registrationRequestId: String,
    quantity: Number,
    serial: Number,
    revision: { type: Number, default: 0 },
    voidedAt: Date,
    voidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'user' },
    voidReason: String,
    printAttempts: [{
        _id: false, requestId: String, by: { type: mongoose.Schema.Types.ObjectId, ref: 'user' },
        employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'employee' },
        at: Date, finishedAt: Date, printer: String,
        result: { type: String, enum: ['Pending', 'Submitted', 'Failed'] },
    }],
    trace: [traceSchema],
    printedBy: {
        type: String
    },
    printedAt: {
        type: Date,
        default: () => Date.now()
    },
    status: {
        type: String,
        default: "Pending"
    }
}, {
    _id: false,
    timestamps: true
})

palletSchema.index({ registrationRequestId: 1 }, { unique: true, partialFilterExpression: { registrationRequestId: { $type: 'string' } } });
palletSchema.index({ productionRunId: 1, registeredAt: 1 });
palletSchema.index({ lotNumber: 1, registeredAt: 1 });
palletSchema.index({ lineId: 1, registeredAt: -1, _id: -1 });

const Pallet = database.model("Pallet", palletSchema, "pallet");

Pallet.watch([], { fullDocument: "updateLookup" })
    .on("change", (change) => {
        switch (change.operationType) {
            case "insert":
            case "update":
            case "replace":
                io.emit("pallet:update", change.fullDocument);
                break;

            case "delete":
                io.emit("pallet:delete", change.documentKey._id);
                break;
        }
    });

module.exports = Pallet;
