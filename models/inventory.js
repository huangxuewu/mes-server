const mongoose = require("mongoose");
const { io } = require("../socket/io");
const database = require("../config/database");

const inventorySchema = new mongoose.Schema({
    sku: { type: String },
    upc: { type: String },
    barcode: { type: String },
    styleCode: { type: String },
    styleName: { type: String },
    color: { type: String },
    size: { type: String },
    totalQuantity: {
        type: Number,
        required: true,
        default: 0,
        validate: {
            validator: Number.isInteger,
            message: 'Quantity must be an integer'
        }
    },
    availableQuantity: {
        type: Number,
        default: 0
    },
    reservedQuantity: {
        type: Number,
        default: 0
    },
    description: { type: String },
    category: {
        type: String,
        required: true,
        enum: ['Finished Goods', 'Raw Material', 'Tool', 'Accessory'],
        index: true
    },
    subcategory: {
        type: String,
        enum: [
            // Packaging specific subcategories
            'Pillow',
            'Corrugated Box', 'Pallet', 'Poly Bag', 'Label', 'Tape',
            'Container', 'Wrap', 'Divider', 'Other Packaging',
            // Other subcategories
            'Fabric', 'Fiber', 'Thread', 'Needle',
            'Tool', 'Machine Part', 'Lubricant', 'Cleaning Supply',
            'Final Product', 'Semi-Finished'
        ],
        index: true
    },
    supplier: {
        _id: { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier' },
        name: { type: String },
        partNumber: { type: String } // Supplier's part number
    },
    minStockLevel: { type: Number, default: 0 },
    reorderPoint: { type: Number, default: 0 },
    leadTime: { type: Number, description: 'Lead time in days' },
    status: {
        type: String,
        enum: ['Active', 'Inactive', 'Discontinued', 'On Order', 'Low Stock', 'Out of Stock'],
        default: 'Active'
    },
    property: {
        type: String,
        description: "Down Home"
    },
    documents: [],
    customFields: { type: Map, of: mongoose.Schema.Types.Mixed }
}, { timestamps: true });


const Inventory = mongoose.model("Inventory", inventorySchema, 'inventory');

Inventory.watch([], { fullDocument: "updateLookup" })
    .on("change", (change) => {

        switch (change.operationType) {
            case "insert":
            case "update":
            case "replace":
                io.emit("inventory:update", change.fullDocument);
                break;
            case "delete":
                io.emit("inventory:delete", change.documentKey._id);
                break;
        }

    });

module.exports = Inventory;
