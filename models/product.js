const mongoose = require("mongoose");
const { io } = require("../socket/io");
const database = require("../config/database");

/**
 * Revision history schema
 */
const revisionHistorySchema = new mongoose.Schema({
    version: { type: String, required: true },
    updatedAt: { type: Date, required: true },
    updatedBy: { type: String, required: true },
    changes: String
}, { _id: false });

/**
 * Specification field schema
 */
const specFieldSchema = new mongoose.Schema({
    name: { type: String, required: true },
    value: { type: String, required: true },
    unit: String,
    type: {
        type: String,
        required: true,
        default: "text",
        enum: ["text", "number", "date", "boolean", "image"]
    }
}, { _id: false });

/**
 * Specification group schema
 */
const specificationSchema = new mongoose.Schema({
    group: { type: String, required: true },
    fields: [specFieldSchema]
}, { _id: false });

const bomSchema = new mongoose.Schema({
    materialId: { type: mongoose.Schema.Types.ObjectId, ref: "rawMaterials" },
    quantity: Number,
    unit: String,
    coversQuantity: Number,
    coversUnit: String,
}, { _id: false });

/**
 * Quality control schema
 */
const qualityControlSchema = new mongoose.Schema({
    testName: String,
    testResult: String,
    testDate: Date,
    standard: String,
    frequency: String,
    acceptCriteria: String
}, { _id: false });

/**
 * Case pack schema
 */
const casePackSchema = new mongoose.Schema({
    packagingType: {
        type: String,
        enum: ["Corrugated Box", "Plastic Bag"]
    },
    unitsPerCase: { type: Number, required: true, min: 1 },
    packagingDimensions: {
        length: { type: Number, min: 0 },
        width: { type: Number, min: 0 },
        height: { type: Number, min: 0 }
    },
    stackability: { type: Number, min: 0 },
    weight: { type: Number, required: true }
}, { _id: false });

/**
 * Storaging schema
 */
const storagingSchema = new mongoose.Schema({
    location: String,
    maxHeight: Number,
    allowOverHang: Boolean,
    boxesPerPallet: Number
}, { _id: false });

const productionSchema = new mongoose.Schema({
    lineId: { type: mongoose.Schema.Types.ObjectId, ref: 'line' },
    bufferRate: Number,
}, { _id: false });

/**
 * Product schema
 */
const productSchema = new mongoose.Schema({
    name: { type: String, required: true },
    description: { type: String, required: true },
    upc: { type: String, index: true },
    sku: { type: String, index: true, unique: true, sparse: true },
    barcode: String,
    letterCode: {
        type: String,
        default: ""
    },
    styleName: { type: String, index: true },
    styleColor: String,
    styleSize: String,
    styleCode: String,
    styleImage: String,
    stylePrice: { type: Number, min: 0 },
    stylePack: { type: Number, min: 1 },
    styleDimensions: {
        length: { type: Number, min: 0 },
        width: { type: Number, min: 0 },
        height: { type: Number, min: 0 }
    },
    styleWeight: {
        min: { type: Number },
        standard: { type: Number },
        max: { type: Number },
        unit: { type: String },
        tolerance: { type: Number }
    },

    version: { type: String, default: "v1.0.0" },
    revisionHistory: [revisionHistorySchema],
    qualityChecks: [qualityControlSchema],
    specification: [specificationSchema],
    storaging: [storagingSchema],
    production: productionSchema,
    casePack: casePackSchema,
    bom: [bomSchema],
    packaging: {
        pillowsPerBag: Number,
        bagsPerBox: Number,
        boxesPerPallet: Number
    },
    status: {
        type: String,
        enum: ["Active", "Development", "Discontinued", "Pre-Production"],
        default: "Development"
    }
}, { timestamps: true });

/**
 * Helper: bump semantic version (v1.0.1 -> v1.0.2)
 */
function bumpVersion(version) {
    if (!version) return "v1.0.0";
    const parts = version.replace("v", "").split(".");
    let major = parseInt(parts[0] || 1, 10);
    let minor = parseInt(parts[1] || 0, 10);
    let patch = parseInt(parts[2] || 0, 10);
    patch += 1;
    return `v${major}.${minor}.${patch}`;
}

/**
 * Helper: compute diff of specification arrays
 */
function diffSpecifications(oldSpecs = [], newSpecs = []) {
    const changes = [];

    const oldMap = {};
    oldSpecs.forEach(spec => {
        spec.fields.forEach(f => {
            oldMap[`${spec.group}:${f.name}`] = f.value;
        });
    });

    newSpecs.forEach(spec => {
        spec.fields.forEach(f => {
            const key = `${spec.group}:${f.name}`;
            if (oldMap[key] !== f.value) {
                changes.push(`${key}: "${oldMap[key] || "-"}" -> "${f.value}"`);
            }
        });
    });

    return changes.join("; ");
}

/**
 * Pre-save hook for .save()
 */
productSchema.pre("save", async function (next) {
    if (!this.isModified("specification")) return next();

    const newVersion = bumpVersion(this.version);
    const changes = diffSpecifications(this.$__.priorDoc?.specification, this.specification);

    this.version = newVersion;
    this.revisionHistory.push({
        version: newVersion,
        updatedAt: new Date(),
        updatedBy: this._updatedBy || "system",
        changes: changes || "Specification updated"
    });

    next();
});

/**
 * Pre hook for findOneAndUpdate
 */
productSchema.pre("findOneAndUpdate", async function (next) {
    const update = this.getUpdate();
    if (!update.specification) return next();

    const docToUpdate = await this.model.findOne(this.getQuery());
    if (!docToUpdate) return next();

    const newVersion = bumpVersion(docToUpdate.version);
    const changes = diffSpecifications(docToUpdate.specification, update.specification);

    // merge into update
    this.findOneAndUpdate({}, {
        $set: { version: newVersion },
        $push: {
            revisionHistory: {
                version: newVersion,
                updatedAt: new Date(),
                updatedBy: update._updatedBy || "system",
                changes: changes || "Specification updated"
            }
        }
    });

    next();
});

/**
 * Model
 */
const Product = database.model("product", productSchema, "product");

/**
 * Change stream to emit via socket.io
 */
Product.watch([], { fullDocument: "updateLookup" })
    .on("change", (change) => {
        switch (change.operationType) {
            case "insert":
            case "update":
            case "replace":
                io.emit("product:update", change.fullDocument);
                break;
            case "delete":
                io.emit("product:delete", change.documentKey._id);
                break;
        }
    });

module.exports = Product;
