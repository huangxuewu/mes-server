const mongoose = require("mongoose");
const { io } = require("../socket/io");
const database = require("../config/database");

const rawMaterialsSchema = new mongoose.Schema({
    materialCode: { 
        type: String, 
        unique: true, 
        required: true,
        trim: true
    },
    name: {
        type: String,
        required: true,
        trim: true
    },
    description: { type: String },
    category: {
        type: String,
        required: true,
        enum: ['Raw Material', 'Component', 'Packaging'],
        default: 'Raw Material',
        index: true
    },
    subcategory: {
        type: String,
        enum: [
            // Raw Materials
            'Fabric', 'Fiber', 'Thread', 'Filling', 'Foam', 'Cotton', 'Polyester',
            'Down', 'Feather', 'Bamboo', 'Linen', 'Silk', 'Wool',
            // Components
            'Zipper', 'Button', 'Label', 'Tag', 'Hardware', 'Needle', 'Hook',
            'Loop', 'Velcro', 'Elastic', 'Ribbon', 'Trim', 'Embellishment',
            // Packaging
            'Box', 'Bag', 'Wrap', 'Tape', 'Label', 'Pallet', 'Container',
            'Poly Bag', 'Corrugated Box', 'Pillow', 'Divider', 'Protective Wrap'
        ],
        index: true
    },
    unit: {
        type: String,
        required: true,
        enum: ['kg', 'g', 'lb', 'oz', 'm', 'cm', 'in', 'ft', 'piece', 'roll', 'sheet', 'yard', 'meter'],
        default: 'piece'
    },
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
    specifications: {
        color: String,
        size: String,
        weight: Number,
        dimensions: {
            length: Number,
            width: Number,
            height: Number,
            unit: { type: String, default: 'cm' }
        },
        properties: { type: Map, of: String }, // Custom properties like thread count, GSM, etc.
        grade: String,
        origin: String
    },
    supplier: {
        _id: { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier' },
        name: { type: String },
        partNumber: { type: String },
        contactInfo: {
            email: String,
            phone: String
        }
    },
    cost: {
        unitCost: { type: Number, min: 0 },
        currency: { type: String, default: 'USD' },
        lastUpdated: Date
    },
    minStockLevel: { type: Number, default: 0 },
    reorderPoint: { type: Number, default: 0 },
    leadTime: { type: Number, description: 'Lead time in days' },
    status: {
        type: String,
        enum: ['Active', 'Inactive', 'Discontinued', 'On Order', 'Low Stock', 'Out of Stock'],
        default: 'Active'
    },
    quality: {
        grade: String,
        certifications: [String],
        testResults: [{
            testName: String,
            result: String,
            date: Date,
            standard: String
        }],
        batchNumber: String,
        expiryDate: Date
    },
    storage: {
        location: String,
        temperature: String,
        humidity: String,
        specialRequirements: String
    },
    documents: [{
        name: String,
        url: String,
        type: String,
        uploadedAt: { type: Date, default: Date.now },
        uploader: { type: mongoose.Schema.Types.ObjectId, ref: "User" }
    }],
    customFields: { type: Map, of: mongoose.Schema.Types.Mixed },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" }
}, { timestamps: true });


// Static method to find materials by category
rawMaterialsSchema.statics.findByCategory = function (category) {
    return this.find({ category, status: 'Active' });
};

// Static method to find low stock materials
rawMaterialsSchema.statics.findLowStock = function () {
    return this.find({
        $expr: { $lte: ['$availableQuantity', '$reorderPoint'] },
        status: 'Active'
    });
};

// Instance method to check if material is in stock
rawMaterialsSchema.methods.isInStock = function (requiredQuantity = 1) {
    return this.availableQuantity >= requiredQuantity;
};

// Instance method to update stock
rawMaterialsSchema.methods.updateStock = function (quantity, operation = 'add') {
    if (operation === 'add') {
        this.totalQuantity += quantity;
        this.availableQuantity += quantity;
    } else if (operation === 'subtract') {
        this.availableQuantity = Math.max(0, this.availableQuantity - quantity);
    }
    return this.save();
};

const RawMaterials = database.model("rawMaterials", rawMaterialsSchema, 'rawMaterials');

// Change stream for real-time updates
RawMaterials.watch([], { fullDocument: "updateLookup" })
    .on("change", (change) => {
        switch (change.operationType) {
            case "insert":
            case "update":
            case "replace":
                io.emit("rawMaterials:update", change.fullDocument);
                break;
            case "delete":
                io.emit("rawMaterials:delete", change.documentKey._id);
                break;
        }
    });

module.exports = RawMaterials;
