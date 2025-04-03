const mongoose = require("mongoose");
const { io } = require("../socket/io");
const database = require("../config/database");

const revisionHistorySchema = new mongoose.Schema({
    version: { type: String, required: true },
    updatedAt: { type: Date, required: true },
    updatedBy: { type: String, required: true },
    changes: String
});

const specificationSchema = new mongoose.Schema({
    name: { type: String, required: true },
    value: { type: String, required: true },
    unt: String
});

const qualityControlSchema = new mongoose.Schema({
    testName: String,
    testResult: String,
    testDate: Date,
    standard: String,
    frequency: String,
    acceptCriteria: String,
});

const casePackSchema = new mongoose.Schema({
    packagingType: {
        type: String,
        enum: ['Corrugated Box', 'Plastic Bag']
    },
    unitsPerCase: {
        type: Number,
        required: true,
        min: 1
    },
    packagingDimensions: {
        length: Number,
        width: Number,
        height: Number
    },
    stackability: {
        type: Number,
        min: 0,
        description: "Maximum number of case layers that can be stacked on top of each other"
    },
    weight: {
        type: Number,
        required: true,
        description: "Weight of the case pack"
    },
});

const storagingSchema = new mongoose.Schema({
    location: String,
    maxHeight: Number,
    allowOverHang: Boolean,
    boxesPerPallet: Number,
});

const productSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true
    },
    description: {
        type: String,
        required: true
    },
    upc: String,
    sku: String,
    barcode: String,
    styleName: String,
    styleColor: String,
    styleSize: String,
    styleCode: String,
    styleImage: String,
    stylePrice: Number,
    stylePack: {
        type: Number,
        description: "Number of units per pack"
    },
    styleDimensions: {
        length: Number,
        width: Number,
        height: Number
    },
    styleWeight: {
        min: Number,
        standard: Number,
        max: Number,
        unit: String,
        tolerance: Number
    },
    version: String,
    revisionHistory: [revisionHistorySchema],
    qualityChecks: [qualityControlSchema],
    specification: [specificationSchema],
    storaging: [storagingSchema],
    casePack: casePackSchema,
    packaging: {
        pillowsPerBag: Number,
        bagsPerBox: Number,
        boxesPerPallet: Number,
    },
    status: {
        type: String,
        enum: ['Active', 'Development', 'Discontinued', 'Pre-Production']
    },
});


const Product = database.model("product", productSchema, 'product');

Product.createIndexes({ "styleName": 1 });

Product.watch([], { fullDocument: "updateLookup" })
    .on("change", (change) => {
        switch (change.operationType) {
            case "insert":
            case "update":
            case "replace":
                io.emit("product:update", change.fullDocument);

                break;
            case "delete":

                break;
        }
    });

module.exports = Product;