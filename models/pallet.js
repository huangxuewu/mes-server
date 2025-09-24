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
    productId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Product",
        required: true,
    },
    tare: {
        type: Number,
        default: 0,
    },
    weight: {
        type: Number,
        default: 0,
    },
    count: {
        type: Number,
        default: 0,
    },
    location: {
        type: String,
    },
    operator: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
    },
    trace: [traceSchema],
    status: {
        type: String,
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