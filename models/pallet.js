const mongoose = require("mongoose");
const { io } = require("../socket/io");
const database = require("../config/database");

const traceSchema = new mongoose.Schema({
    date: { type: Date, default: null },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
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
    trace: [traceSchema],
    operator: String,
    status: {
        type: String,
        default: "Pending"
    }
}, {
    _id: false,
    timestamps: true
})

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
                io.emit("pallet:delete", change.fullDocument);
                break;
        }
    });

module.exports = Pallet;