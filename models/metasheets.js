const mongoose = require("mongoose");
const { io } = require("../socket/io");
const database = require("../config/database");
const metasheetsSchema = new mongoose.Schema({
    key: {
        type: String,
        required: true,
        unique: true,
        enum: [
            'PRODUCT_FINISHED',
            'CONSUMABLE_RAW',
            'CONSUMABLE_PACKAGING',
            'CONSUMABLE_ACCESSORY',
            'TOOL_GENERIC'
        ],
        description: "Unique business identifier for the metasheet"
    },

    label: {
        type: String,
        required: true,
        description: "Display name for UI"
    },

    appliesTo: {
        type: String,
        required: true,
        enum: ['PRODUCT', 'MATERIAL'],
        description: "Which item type this metasheet applies to"
    },

    category: {
        type: String,
        required: true,
        enum: ['PRODUCT', 'CONSUMABLE', 'TOOL'],
        description: "High-level behavior category"
    },

    subcategory: {
        type: String,
        enum: ['FINISHED', 'RAW', 'PACKAGING', 'ACCESSORY'],
        default: null,
        description: "More detailed breakdown"
    },

    behavior: {
        isConsumable: { type: Boolean, default: false },
        trackByLot: { type: Boolean, default: false },
        trackBySerial: { type: Boolean, default: false },
        allowInBOM: { type: Boolean, default: false },
        allowAsBOMRoot: { type: Boolean, default: false },
        usesPalletInventory: { type: Boolean, default: false },
        usesShelfInventory: { type: Boolean, default: false },
        allowBorrowReturn: { type: Boolean, default: false },
        qcRequiredOnReceipt: { type: Boolean, default: false },
        note: { type: String }
    }

}, { timestamps: true });

const metasheets = database.model("metasheets", metasheetsSchema);

metasheets.watch([], { fullDocument: "updateLookup" })
    .on("change", (change) => {
        switch (change.operationType) {
            case "insert":
            case "update":
            case "replace":
                io.emit("metasheets:update", change.fullDocument);
                break;
            case "delete":
                io.emit("metasheets:delete", change.fullDocument);
                break;
        }
    });

module.exports = metasheets;