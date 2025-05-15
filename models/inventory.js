const mongoose = require("mongoose");
const database = require("../config/database");

const inventorySchema = new mongoose.Schema({
    sku: { type: String },
    upc: { type: String },
    barcode: { type: String },
    styleCode: { type: String },
    styleName: { type: String },
    color: { type: String },
    size: { type: String },
    quantity: {
        type: Number,
        required: true,
        default: 0,
        validate: {
            validator: Number.isInteger,
            message: 'Quantity must be an integer'
        }
    },
    description: { type: String },
    category: {
        type: String,
        required: true,
        enum: ['Finished Goods', 'Raw Material', 'Supply', 'Packaging', 'Equipment'],
        index: true
    },
    subcategory: {
        type: String,
        enum: [
            // Packaging specific subcategories
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
}, { timestamps: true });


module.exports = mongoose.model("Inventory", inventorySchema, 'inventory');
