const mongoose = require("mongoose");
const { io } = require("../socket/io");
const database = require("../config/database");

const accessoriesSchema = new mongoose.Schema({
    accessoryCode: {
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
        enum: ['Accessory', 'Cleaning Supply', 'Lubricant', 'Safety Equipment', 'Office Supply'],
        default: 'Accessory',
        index: true
    },
    subcategory: {
        type: String,
        enum: [
            // Sewing Supplies
            'Needle', 'Thread', 'Zipper', 'Hook', 'Loop', 'Velcro', 'Elastic',
            'Ribbon', 'Trim', 'Poly Bag', 'Carton Box', 'Label', 'Tag',
            'Thread Snip', 'Scissor',

            // Cleaning & Maintenance
            'Detergent', 'Cleaning Cloth', 'Brush', 'Vacuum', 'Air Compressor',
            'Filter', 'Oil',

            // Safety Equipment
            'Gloves', 'Ear Protection', 'Respirator', 'Safety Vest',
            'First Aid Kit', 'Fire Extinguisher',

            // Office / Production Support
            'Paper', 'Marker', 'Tape', 'Clipboard', 'Folder',

            // Other Accessories
            'Battery', 'Light Bulb', 'Other',

            // Safety Equipment
            'Safety Glasses', 'Goggle Mask', 'Gloves', 'Ear Protection', 'Respirator',
            'Safety Vest', 'First Aid Kit', 'Fire Extinguisher',
        ],
        index: true
    },
    unit: {
        type: String,
        required: true,
        enum: ['piece', 'kg', 'g', 'lb', 'oz', 'liter', 'ml', 'gallon', 'roll', 'box', 'pack'],
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
        brand: String,
        model: String,
        size: String,
        color: String,
        material: String,
        dimensions: {
            length: Number,
            width: Number,
            height: Number,
            unit: { type: String, default: 'cm' }
        },
        weight: Number,
        weightUnit: { type: String, default: 'kg' },
        capacity: String,
        concentration: String, // For cleaning supplies
        pH: Number, // For cleaning supplies
        temperature: String, // Operating temperature range
        expiryDate: Date // For items with expiration
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
        enum: ['Active', 'Inactive', 'Discontinued', 'On Order', 'Low Stock', 'Out of Stock', 'Expired'],
        default: 'Active'
    },
    storage: {
        location: String,
        temperature: String,
        humidity: String,
        specialRequirements: String,
        shelfLife: Number, // in days
        batchNumber: String
    },
    usage: {
        department: String,
        assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee' },
        project: String,
        lastUsed: Date,
        usageNotes: String
    },
    safety: {
        hazardous: { type: Boolean, default: false },
        safetyDataSheet: String,
        handlingInstructions: String,
        disposalInstructions: String,
        personalProtectiveEquipment: [String],
        storageRequirements: String
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
        condition: {
            type: String,
            enum: ['New', 'Good', 'Fair', 'Poor', 'Expired'],
            default: 'New'
        }
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

// Indexes for better query performance

// Static method to find expired accessories
accessoriesSchema.statics.findExpired = function () {
    const today = new Date();
    return this.find({
        $or: [
            { 'specifications.expiryDate': { $lte: today } },
            { status: 'Expired' }
        ]
    });
};

// Static method to find low stock accessories
accessoriesSchema.statics.findLowStock = function () {
    return this.find({
        $expr: { $lte: ['$availableQuantity', '$reorderPoint'] },
        status: 'Active'
    });
};

// Static method to find hazardous accessories
accessoriesSchema.statics.findHazardous = function () {
    return this.find({
        'safety.hazardous': true,
        status: 'Active'
    });
};

// Instance method to check if accessory is available
accessoriesSchema.methods.isAvailable = function (requiredQuantity = 1) {
    return this.availableQuantity >= requiredQuantity &&
        this.status === 'Active' &&
        (!this.specifications.expiryDate || this.specifications.expiryDate > new Date());
};

// Instance method to update stock
accessoriesSchema.methods.updateStock = function (quantity, operation = 'add') {
    if (operation === 'add') {
        this.totalQuantity += quantity;
        this.availableQuantity += quantity;
    } else if (operation === 'subtract') {
        this.availableQuantity = Math.max(0, this.availableQuantity - quantity);
    }
    return this.save();
};

// Instance method to check if expired
accessoriesSchema.methods.isExpired = function () {
    return this.specifications.expiryDate && this.specifications.expiryDate <= new Date();
};

// Pre-save hook to check expiration
accessoriesSchema.pre('save', function (next) {
    if (this.isExpired()) {
        this.status = 'Expired';
    }
    next();
});

const Accessories = database.model("accessories", accessoriesSchema, 'accessories');

// Change stream for real-time updates
Accessories.watch([], { fullDocument: "updateLookup" })
    .on("change", (change) => {
        switch (change.operationType) {
            case "insert":
            case "update":
            case "replace":
                io.emit("accessories:update", change.fullDocument);
                break;
            case "delete":
                io.emit("accessories:delete", change.documentKey._id);
                break;
        }
    });

module.exports = Accessories;
