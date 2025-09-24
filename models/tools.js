const mongoose = require("mongoose");
const { io } = require("../socket/io");
const database = require("../config/database");

const toolsSchema = new mongoose.Schema({
    toolCode: { 
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
        enum: ['Tool', 'Machine Part', 'Equipment'],
        default: 'Tool',
        index: true
    },
    subcategory: {
        type: String,
        enum: [
            'Hand Tool', 'Power Tool', 'Measuring Tool', 'Cutting Tool',
            'Sewing Machine', 'Cutting Machine', 'Pressing Machine',
            'Motor', 'Belt', 'Needle', 'Thread Guide', 'Tension Device',
            'Maintenance Tool', 'Safety Equipment', 'Other'
        ],
        index: true
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
        serialNumber: String,
        powerRating: String,
        dimensions: {
            length: Number,
            width: Number,
            height: Number,
            unit: { type: String, default: 'cm' }
        },
        weight: Number,
        weightUnit: { type: String, default: 'kg' },
        operatingVoltage: String,
        operatingFrequency: String,
        capacity: String,
        precision: String
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
        enum: ['Active', 'Inactive', 'Discontinued', 'On Order', 'Low Stock', 'Out of Stock', 'Under Maintenance'],
        default: 'Active'
    },
    maintenance: {
        lastMaintenanceDate: Date,
        nextMaintenanceDate: Date,
        maintenanceInterval: Number, // in days
        maintenanceNotes: String,
        warrantyExpiry: Date,
        serviceProvider: String
    },
    location: {
        building: String,
        floor: String,
        room: String,
        workstation: String,
        storageLocation: String
    },
    usage: {
        assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee' },
        department: String,
        project: String,
        usageHours: { type: Number, default: 0 },
        lastUsed: Date
    },
    quality: {
        condition: {
            type: String,
            enum: ['Excellent', 'Good', 'Fair', 'Poor', 'Needs Repair'],
            default: 'Good'
        },
        certifications: [String],
        testResults: [{
            testName: String,
            result: String,
            date: Date,
            standard: String
        }]
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

// Virtual for full tool identifier
toolsSchema.virtual('fullIdentifier').get(function () {
    return this.toolCode || this.name;
});

// Static method to find tools by category
toolsSchema.statics.findByCategory = function (category) {
    return this.find({ category, status: 'Active' });
};

// Static method to find tools needing maintenance
toolsSchema.statics.findNeedingMaintenance = function () {
    const today = new Date();
    return this.find({
        $or: [
            { 'maintenance.nextMaintenanceDate': { $lte: today } },
            { 'quality.condition': { $in: ['Poor', 'Needs Repair'] } }
        ],
        status: 'Active'
    });
};

// Static method to find low stock tools
toolsSchema.statics.findLowStock = function () {
    return this.find({
        $expr: { $lte: ['$availableQuantity', '$reorderPoint'] },
        status: 'Active'
    });
};

// Instance method to check if tool is available
toolsSchema.methods.isAvailable = function (requiredQuantity = 1) {
    return this.availableQuantity >= requiredQuantity && this.status === 'Active';
};

// Instance method to update stock
toolsSchema.methods.updateStock = function (quantity, operation = 'add') {
    if (operation === 'add') {
        this.totalQuantity += quantity;
        this.availableQuantity += quantity;
    } else if (operation === 'subtract') {
        this.availableQuantity = Math.max(0, this.availableQuantity - quantity);
    }
    return this.save();
};

// Instance method to assign tool
toolsSchema.methods.assignTool = function (employeeId, department, project) {
    this.usage.assignedTo = employeeId;
    this.usage.department = department;
    this.usage.project = project;
    this.usage.lastUsed = new Date();
    return this.save();
};

const Tools = database.model("tools", toolsSchema, 'tools');

// Change stream for real-time updates
Tools.watch([], { fullDocument: "updateLookup" })
    .on("change", (change) => {
        switch (change.operationType) {
            case "insert":
            case "update":
            case "replace":
                io.emit("tools:update", change.fullDocument);
                break;
            case "delete":
                io.emit("tools:delete", change.documentKey._id);
                break;
        }
    });

module.exports = Tools;
