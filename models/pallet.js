const mongoose = require("mongoose");
const { io } = require("../socket/io");
const database = require("../config/database");

const generatePalletId = async function () {
    try {
        const [YYYY, MM, DD] = new Date().toISOString().split("T")[0].split("-");
        const target = `PLT-${YYYY.slice(-2)}${MM}${DD}`;

        const counterDoc = await mongoose.model("Counter").findOneAndUpdate(
            { _id: target },
            { $inc: { sequence: 1 } },
            { new: true, upsert: true, lean: true }
        );

        const sequence = String(counterDoc.sequence).padStart(4, "0");
        const palletId = `${target}-${sequence}`;

        return palletId;
    } catch (error) {
        console.error("Error generating pallet ID:", error);
        return null;
    }
}

const palletSchema = new mongoose.Schema({
    _id: {
        type: String,
        default: generatePalletId,
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
    status: {
        type: String,
    }
}, {
    _id: false,
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