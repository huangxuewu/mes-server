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
            'PRODUCT_SEMI_FINISHED',
            'MATERIAL_RAW',
            'MATERIAL_PACKAGING',
            'MATERIAL_ACCESSORY',
            'TOOL'
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
        enum: ['PRODUCT', 'MATERIAL', 'TOOL'],
        description: "Which item type this metasheet applies to"
    },

    category: {
        type: String,
        required: true,
        enum: ['PRODUCT', 'MATERIAL', 'TOOL'],
        description: "High-level behavior category"
    },

    subcategory: {
        type: String,
        enum: ['FINISHED', 'SEMI_FINISHED', 'RAW', 'PACKAGING', 'ACCESSORY', null],
        default: null,
        description: "More detailed breakdown under category"
    },

    behavior: {
        isConsumable: {
            type: Boolean,
            default: false,
            description: "Item is consumed in production (quantity decreases per cycle)"
        },
        trackByLot: {
            type: Boolean,
            default: false,
            description: "Item must have lot/batch tracking for traceability and segregation"
        },
        trackBySerial: {
            type: Boolean,
            default: false,
            description: "Each piece has its own serial identity (e.g. tools, assets)"
        },
        allowInBOM: {
            type: Boolean,
            default: false,
            description: "Item can appear as a BOM component under a finished or semi-finished good"
        },
        allowAsBOMRoot: {
            type: Boolean,
            default: false,
            description: "Item can be a BOM root (finished good or semi-assembly)"
        },
        usePalletInventory: {
            type: Boolean,
            default: false,
            description: "Inventory stored and tracked using pallets (common for raw, packaging, finished goods)"
        },
        useShelfInventory: {
            type: Boolean,
            default: false,
            description: "Inventory stored as loose or shelf stock (tools, small items)"
        },
        allowBorrowReturn: {
            type: Boolean,
            default: false,
            description: "Item supports check-out / return workflow (tools, shared equipment)"
        },
        qcRequiredOnReceipt: {
            type: Boolean,
            default: false,
            description: "Item enters QC Hold when received until inspection passes"
        },
        requireOriginInfo: {
            type: Boolean,
            default: false,
            description: "Material must include origin information (country, region, factory) for compliance"
        },
        requireSupplierInfo: {
            type: Boolean,
            default: false,
            description: "Material must link to supplier/contract information before use"
        },
        requireFscInfo: {
            type: Boolean,
            default: false,
            description: "Item requires FSC claim and certificate details to maintain chain-of-custody compliance"
        }
    },

    note: { type: String }
}, { timestamps: true });


const metasheets = database.model("metasheets", metasheetsSchema, "metasheets");

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