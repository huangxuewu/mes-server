const mongoose = require("mongoose");
const { io } = require("../socket/io");
const database = require("../config/database");

const documentSchema = new mongoose.Schema({
    name: String,
    url: String,
    type: String,
    uploadedAt: { type: Date, default: Date.now },
    uploader: { type: mongoose.Schema.Types.ObjectId, ref: "User" }
});

const finishedGoodsSchema = new mongoose.Schema({
    sku: { type: String, unique: true, sparse: true },
    upc: { type: String, unique: true, sparse: true },
    barcode: { type: String, unique: true, sparse: true },
    styleCode: { type: String },
    styleName: { type: String, required: true },
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
        enum: ['Final Product', 'Semi-Finished'],
        default: 'Final Product',
        index: true
    },
    subcategory: {
        type: String,
        enum: [
            'Pillow', 'Mattress', 'Cushion', 'Comforter', 'Sheet Set',
            'Pillowcase', 'Duvet Cover', 'Bed Skirt', 'Throw Blanket',
            'Other'
        ],
        index: true
    },
    productId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Product',
        required: true
    },
    specifications: {
        dimensions: {
            length: Number,
            width: Number,
            height: Number,
            unit: { type: String, default: 'cm' }
        },
        weight: Number,
        weightUnit: { type: String, default: 'kg' },
        materials: [String], // List of materials used
        careInstructions: String,
        certifications: [String]
    },
    pricing: {
        cost: { type: Number, min: 0 },
        sellingPrice: { type: Number, min: 0 },
        currency: { type: String, default: 'USD' }
    },
    supplier: {
        _id: { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier' },
        name: { type: String },
        partNumber: { type: String }
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
    quality: {
        grade: String,
        testResults: [{
            testName: String,
            result: String,
            date: Date,
            standard: String
        }]
    },
    documents: [documentSchema],
    customFields: { type: Map, of: mongoose.Schema.Types.Mixed },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" }
}, { timestamps: true });

// Virtual for full product identifier
finishedGoodsSchema.virtual('fullIdentifier').get(function () {
    return this.sku || this.styleCode || this.styleName;
});

// Static method to find low stock finished goods
finishedGoodsSchema.statics.findLowStock = function () {
    return this.find({
        $expr: { $lte: ['$availableQuantity', '$reorderPoint'] },
        status: 'Active'
    });
};

// Instance method to check if product is in stock
finishedGoodsSchema.methods.isInStock = function (requiredQuantity = 1) {
    return this.availableQuantity >= requiredQuantity;
};

// Instance method to update stock
finishedGoodsSchema.methods.updateStock = function (quantity, operation = 'add') {
    if (operation === 'add') {
        this.totalQuantity += quantity;
        this.availableQuantity += quantity;
    } else if (operation === 'subtract') {
        this.availableQuantity = Math.max(0, this.availableQuantity - quantity);
    }
    return this.save();
};

const FinishedGoods = database.model("finishedGoods", finishedGoodsSchema, 'finishedGoods');

// Change stream for real-time updates
FinishedGoods.watch([], { fullDocument: "updateLookup" })
    .on("change", (change) => {
        switch (change.operationType) {
            case "insert":
            case "update":
            case "replace":
                io.emit("finishedGoods:update", change.fullDocument);
                break;
            case "delete":
                io.emit("finishedGoods:delete", change.documentKey._id);
                break;
        }
    });

module.exports = FinishedGoods;
