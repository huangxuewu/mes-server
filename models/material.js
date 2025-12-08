const mongoose = require("mongoose");
const { io } = require("../socket/io");
const database = require("../config/database");

/**
 * Contact Info Schema
 */
const contactInfoSchema = new mongoose.Schema({
    email: { type: String, trim: true },
    phone: { type: String, trim: true },
    address: { type: String, trim: true }
}, { _id: false });

/**
 * Point of Contact Schema
 */
const pointOfContactSchema = new mongoose.Schema({
    name: { type: String, trim: true },
    title: { type: String, trim: true },
    email: { type: String, trim: true },
    telephone: { type: String, trim: true },
    extension: { type: String, trim: true },
    cellphone: { type: String, trim: true }
}, { _id: false });

/**
 * Supplier Schema
 */
const supplierSchema = new mongoose.Schema({
    alias: { type: String, trim: true },
    companyName: { type: String, trim: true },
    countryOfOrigin: { type: String, trim: true },
    contactInfo: contactInfoSchema,
    pointOfContact: pointOfContactSchema
}, { _id: false });

/**
 * Weight Schema
 */
const weightSchema = new mongoose.Schema({
    standard: { type: Number, default: 0, min: 0 },
    tolerance: { type: Number, default: 0, min: 0 },
    unit: { type: String, default: 'lbs', enum: ['lbs', 'kg', 'g', 'oz'] }
}, { _id: false });

/**
 * Dimensions Schema
 */
const dimensionsSchema = new mongoose.Schema({
    length: { type: Number, default: 0, min: 0 },
    width: { type: Number, default: 0, min: 0 },
    height: { type: Number, default: 0, min: 0 },
    unit: { type: String, default: 'in', enum: ['in', 'cm', 'm', 'ft'] }
}, { _id: false });

/**
 * Storage Schema
 */
const storageSchema = new mongoose.Schema({
    location: { type: String, trim: true },
    maxHeight: { type: Number, default: 0, min: 0 },
    allowOverHang: { type: Boolean, default: false },
    allowStacking: { type: Boolean, default: false },
    unitsPerPallet: { type: Number, default: 0, min: 0 }
}, { _id: false });

/**
 * Specification Field Schema (for dynamic specifications)
 */
const specFieldSchema = new mongoose.Schema({
    name: { type: String, required: true, trim: true },
    value: { type: mongoose.Schema.Types.Mixed },
    unit: { type: String, trim: true },
    type: {
        type: String,
        enum: ['text', 'number', 'date', 'boolean', 'image'],
        default: 'text'
    }
}, { _id: false });

/**
 * Specification Schema
 */
const specificationSchema = new mongoose.Schema({
    group: { type: String, trim: true },
    fields: [specFieldSchema]
}, { _id: false });

/**
 * Inspection Schema
 */
const inspectionSchema = new mongoose.Schema({
    checkName: { type: String, required: true, trim: true },
    checkType: { type: String, trim: true },
    required: { type: Boolean, default: false },
    criteria: { type: String, trim: true },
    frequency: { type: String, trim: true },
    notes: { type: String, trim: true }
}, { _id: false });

/**
 * Temperature Range Schema
 */
const temperatureRangeSchema = new mongoose.Schema({
    min: { type: String, trim: true },
    max: { type: String, trim: true }
}, { _id: false });

/**
 * Environment Schema
 */
const environmentSchema = new mongoose.Schema({
    humidityLevel: { type: String, trim: true },
    temperatureRange: temperatureRangeSchema,
    lightExposure: { type: String, trim: true },
    ventilation: { type: String, trim: true },
    otherRequirements: { type: String, trim: true }
}, { _id: false });

/**
 * Logistics Schema
 */
const logisticsSchema = new mongoose.Schema({
    shippingMethod: { type: String, trim: true },
    estimatedShippingDays: { type: Number, default: 0, min: 0 },
    customsRequired: { type: Boolean, default: false },
    specialHandling: { type: Boolean, default: false },
    handlingNotes: { type: String, trim: true }
}, { _id: false });

/**
 * Inventory Schema
 */
const inventorySchema = new mongoose.Schema({
    safeStockLevel: { type: Number, default: 0, min: 0 },
    reorderPoint: { type: Number, default: 0, min: 0 },
    productionDays: { type: Number, default: 0, min: 0 },
    logistics: logisticsSchema,
    environment: environmentSchema
}, { _id: false });

/**
 * Material Schema
 */
const materialSchema = new mongoose.Schema({
    // Basic Information
    name: {
        type: String,
        required: true,
        trim: true,
        index: true
    },
    code: {
        type: String,
        required: true,
        unique: true,
        trim: true,
        index: true
    },
    description: {
        type: String,
        trim: true
    },
    category: {
        type: String,
        trim: true,
        index: true
    },
    grade: {
        type: String,
        trim: true
    },
    color: {
        type: String,
        trim: true
    },
    size: {
        type: String,
        trim: true
    },
    metasheetKey: {
        type: String,
        trim: true,
        index: true
    },

    // Supplier Information (detailed)
    supplier: supplierSchema,

    // Physical Properties
    unit: {
        type: String,
        default: 'lbs',
        enum: ['lbs', 'kg', 'g', 'oz', 'pcs', 'roll', 'sheet', 'yd', 'm', 'cm', 'in', 'ft']
    },
    weight: weightSchema,
    dimensions: dimensionsSchema,

    // Storage
    storage: storageSchema,

    // Specifications (dynamic array)
    specification: [specificationSchema],

    // Inspection checks
    inspection: [inspectionSchema],

    // Inventory Management
    inventory: inventorySchema,

    // Status
    status: {
        type: String,
        enum: ['Active', 'Inactive', 'Discontinued', 'On Order', 'Low Stock', 'Out of Stock'],
        default: 'Active',
        index: true
    },
    notes: {
        type: String,
        trim: true
    }
}, { timestamps: true });

// Static method to find materials by category
materialSchema.statics.findByCategory = function (category) {
    return this.find({ category, status: 'Active' });
};

// Static method to find low stock materials
materialSchema.statics.findLowStock = function () {
    return this.find({
        $expr: {
            $lte: [
                { $ifNull: ['$inventory.safeStockLevel', 0] },
                { $ifNull: ['$inventory.reorderPoint', 0] }
            ]
        },
        status: 'Active'
    });
};

// Instance method to check if material needs reordering
materialSchema.methods.needsReorder = function () {
    if (!this.inventory || !this.inventory.reorderPoint) return false;
    // This would need actual stock quantity from inventory system
    // For now, just return based on reorder point configuration
    return true;
};

const Material = database.model("material", materialSchema, "material");

// Change stream for real-time updates
Material.watch([], { fullDocument: "updateLookup" })
    .on("change", (change) => {
        switch (change.operationType) {
            case "insert":
            case "update":
            case "replace":
                io.emit("material:update", change.fullDocument);
                break;
            case "delete":
                io.emit("material:delete", change.documentKey._id);
                break;
        }
    });

module.exports = Material;