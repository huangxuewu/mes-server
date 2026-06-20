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
    name: { type: String },
    alias: { type: String },
    description: { type: String },
    sku: { type: String, index: true, unique: true, sparse: true },
    upc: { type: String, index: true, default: "" },
    brand: { type: String, default: "Down Home" },
    metasheetKey: { type: String, default: "" },
    barcode: { type: String, default: "" },
    letterCode: {
        type: String,
        default: ""
    },
    styleName: { type: String, index: true },
    styleColor: String,
    styleSize: String,
    firmness: String,
    styleCode: String,
    styleImage: String,
    stylePrice: { type: Number, min: 0 },
    stylePack: { type: Number, min: 1 },
    styleDimensions: {
        length: { type: Number, min: 0 },
        width: { type: Number, min: 0 },
        height: { type: Number, min: 0 },
        unit: { type: String, default: "in" }
    },
    styleWeight: {
        unit: { type: String, default: "oz" },
        fillWeight: { type: Number, default: 0 },
        shellWeight: { type: Number, default: 0 },
        grossWeight: { type: Number, default: 0 },
        upperTolerance: { type: Number, default: 0 },
        lowerTolerance: { type: Number, default: 0 },
    },
    customerSpecific: Boolean,
    customerIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "customer" }],
    version: { type: String, default: "v1.0.0" },
    revisionHistory: [revisionHistorySchema],
    qualityChecks: [qualityControlSchema],
    storaging: [storagingSchema],
    production: productionSchema,
    casePack: casePackSchema,
    specification: {},
    bom: [bomSchema],
    packaging: {
        pillowsPerBag: Number,
        bagsPerBox: Number,
        boxesPerPallet: Number,
        boxMaterialReferenceId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'rawMaterials',
            default: null
        }
    },
    pricing: {
        model: {
            type: String,
            enum: ["Fixed Fee", "Cost Plus", "Margin Based"],
            default: "Fixed Fee"
        },
        currency: {
            type: String,
            enum: ["USD", "EUR", "GBP", "JPY", "CNY", "INR", "BDT"],
            default: "USD"
        },
        fee: {
            amount: {
                type: Number,
                min: 0
            },
            basis: {
                type: String,
                enum: ["Per Piece", "Per Bag", "Per Box", "Per Pallet"],
                default: "Per Piece"
            }
        }
    },
    status: {
        type: String,
        enum: ["Draft", "Active", "Development", "Discontinued", "Pre-Production"],
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
 * Helper: normalize specification to a flat change map (supports legacy array + grouped object)
 */
function specsToChangeMap(specs) {
    const map = {};

    if (Array.isArray(specs)) {
        specs.forEach(spec => {
            (spec?.fields || []).forEach(f => {
                map[`${spec.group}:${f.name}`] = f.value;
            });
        });
        return map;
    }

    if (!specs || typeof specs !== 'object') return map;

    for (const [group, rows] of Object.entries(specs)) {
        if (!Array.isArray(rows)) continue;
        rows.forEach(row => {
            const name = String(row?.[1] ?? '').trim();
            if (!name) return;
            const values = Array.isArray(row) ? row.slice(2).map(v => String(v ?? '').trim()).filter(Boolean) : [];
            map[`${group}:${name}`] = values.join(', ');
        });
    }

    return map;
}

/**
 * Helper: compute diff of specification (array or grouped object)
 */
function diffSpecifications(oldSpecs, newSpecs) {
    const oldMap = specsToChangeMap(oldSpecs);
    const newMap = specsToChangeMap(newSpecs);
    const changes = [];

    for (const [key, value] of Object.entries(newMap)) {
        if (oldMap[key] !== value)
            changes.push(`${key}: "${oldMap[key] || '-'}" -> "${value}"`);
    }

    return changes.join('; ');
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
    try {
        const update = this.getUpdate() || {};
        const $set = { ...(update.$set || {}) };
        const newSpecification = $set.specification ?? update.specification;
        if (!newSpecification) return next();

        const docToUpdate = await this.model.findOne(this.getQuery());
        if (!docToUpdate) return next();

        const newVersion = bumpVersion(docToUpdate.version);
        const changes = diffSpecifications(docToUpdate.specification, newSpecification);

        delete $set.revisionHistory;
        delete update.revisionHistory;
        $set.version = newVersion;

        this.setUpdate({
            ...update,
            $set,
            $push: {
                ...(update.$push || {}),
                revisionHistory: {
                    version: newVersion,
                    updatedAt: new Date(),
                    updatedBy: $set._updatedBy || "system",
                    changes: changes || "Specification updated"
                }
            }
        });

        next();
    } catch (err) {
        next(err);
    }
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
