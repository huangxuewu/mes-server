const mongoose = require("mongoose");
const { io } = require("../socket/io");
const database = require("../config/database");

const revisionHistorySchema = new mongoose.Schema({
    version: String,
    changes: [{
        field: String,
        oldValue: String,
        newValue: String,
    }],
    updatedAt: { type: Date, default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
});

const materialSchema = new mongoose.Schema({
    // Reference to the appropriate collection based on material type
    materialId: { type: mongoose.Schema.Types.ObjectId, required: true },
    materialType: {
        type: String,
        required: true,
        enum: ['finishedGoods', 'rawMaterials', 'tools', 'accessories'],
        description: "Type of material collection this references"
    },
    quantity: { type: Number, required: true },
    unit: { type: String, required: true },
    coversQuantity: Number,
    coversUnit: String,
    wastageAllowance: {
        type: Number,
        default: 0,
        description: "Wastage allowance as a percentage of the material quantity",
    },
    notes: String, // Additional notes for this material in the BOM
});

// Bill of Materials
const bomSchema = new mongoose.Schema({
    name: String,
    description: String,
    productId: { type: mongoose.Schema.Types.ObjectId, ref: "Product" },
    materials: [materialSchema],
    revisionHistory: [revisionHistorySchema],
    effectiveDate: { type: Date, default: null },
    expirationDate: { type: Date, default: null },
    status: { type: String, enum: ["Active", "Inactive", "Archived"], default: "Active" },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    revision: { type: Number, default: 1 },
}, { timestamps: true });

// Add virtual to get the correct model reference based on materialType
materialSchema.virtual('materialRef').get(function () {
    const models = {
        'finishedGoods': require('./finishedGoods'),
        'rawMaterials': require('./rawMaterials'),
        'tools': require('./tools'),
        'accessories': require('./accessories')
    };
    return models[this.materialType];
});


materialSchema.pre("save", async function (next) {
    // Skip if no modifications
    if (!this.isModified()) return next();

    // For new documents, no revision history needed
    if (this.isNew) return next();

    try {
        // Get the original document for comparison
        const original = await this.constructor.findById(this._id).lean();
        if (!original) return next();

        const changes = [];

        // Track material changes
        if (this.isModified('materials')) {
            const oldMaterials = original.materials || [];
            const newMaterials = this.materials || [];

            // Check for added materials
            for (const newMaterial of newMaterials) {
                const oldMaterial = oldMaterials.find(m =>
                    m.materialId && newMaterial.materialId &&
                    m.materialId.toString() === newMaterial.materialId.toString()
                );

                if (!oldMaterial) {
                    changes.push({
                        field: "materials",
                        oldValue: null,
                        newValue: `Added material: ${newMaterial.materialId}`,
                    });
                } else if (oldMaterial.quantity !== newMaterial.quantity) {
                    changes.push({
                        field: "materials",
                        oldValue: `Material ${newMaterial.materialId}: quantity ${oldMaterial.quantity}`,
                        newValue: `Material ${newMaterial.materialId}: quantity ${newMaterial.quantity}`,
                    });
                }
            }

            // Check for removed materials
            for (const oldMaterial of oldMaterials) {
                const newMaterial = newMaterials.find(m =>
                    m.materialId && oldMaterial.materialId &&
                    m.materialId.toString() === oldMaterial.materialId.toString()
                );

                if (!newMaterial) {
                    changes.push({
                        field: "materials",
                        oldValue: `Removed material: ${oldMaterial.materialId}`,
                        newValue: null,
                    });
                }
            }
        }

        // Track other field changes
        const fieldsToTrack = ['name', 'description', 'status', 'effectiveDate', 'expirationDate'];
        for (const field of fieldsToTrack) {
            if (this.isModified(field)) {
                changes.push({
                    field: field,
                    oldValue: original[field] || null,
                    newValue: this[field] || null,
                });
            }
        }

        // Add revision history entry if there are changes
        if (changes.length > 0) {
            this.revisionHistory.push({
                version: `v${this.revision + 1}`,
                changes: changes,
                updatedAt: new Date(),
                updatedBy: this.updatedBy || this.createdBy
            });
            this.revision += 1;
        }

        next();
    } catch (error) {
        next(error);
    }
});

const Bom = database.model("bom", bomSchema, "bom");

Bom.watch([], { fullDocument: "updateLookup" })
    .on("change", (change) => {
        switch (change.operationType) {
            case "insert":
            case "update":
            case "replace":
                io.emit("bom:update", change.fullDocument);
                break;

            case "delete":
                io.emit("bom:delete", change.documentKey._id);
                break;
        }
    });

module.exports = Bom;