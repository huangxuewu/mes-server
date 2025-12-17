const mongoose = require("mongoose");
const { io } = require("../socket/io");
const database = require("../config/database");

const configSchema = new mongoose.Schema({
    _id: {
        type: String,
        required: true,
        description: "Config ID"
    },
    key: {
        type: String,
        required: true,
        description: "Config key"
    },
    value: {
        type: mongoose.Schema.Types.Mixed,
        description: "Config value",
        required: true,
    },
    scope: {
        type: String,
        required: true,
        description: "Config scope",
        enum: ["User", "Role", "Machine", "Line", "Plant", "Tenant", "Global"],
        default: "Global",
        // Meaning:
        // User-level overrides everything else (personal preference or permission).
        // Role-level (e.g. QC manager vs operator) overrides machine defaults.
        // Machine-level overrides line defaults.
        // Line-level overrides plant defaults.
        // Plant-level overrides tenant defaults.
        // Tenant-level (your manufacturing company) overrides global.
        // Global is the ultimate fallback.
    },
    target: {
        tenantId: { type: String, default: null, index: true },
        plantId: { type: String, default: null, index: true },
        lineId: { type: String, default: null, index: true },
        machineId: { type: String, default: null, index: true },
        roleId: { type: String, default: null, index: true },
        userId: { type: String, default: null, index: true }
    },
    type: {
        type: String,
        required: true,
        description: "Config type",
        enum: ["String", "Number", "Boolean", "Object", "Array"],
        default: "String",
    },
    validation: { jsonSchema: mongoose.Schema.Types.Mixed },
    meta: {},
    effective: {
        from: { type: Date, required: true, index: true },
        to: { type: Date, default: null, index: true }
    },
    audit: {
        createdBy: String,
        updatedBy: String,
        changeNote: String
    },
    status: {
        type: String,
        required: true,
        description: "Config status",
        enum: ["Active", "Inactive", "Archived"],
        default: "Active",
    },
    version: {
        type: Number,
        required: true,
        description: "Config version",
        default: 1,
    }
}, { timestamps: true });

const Config = database.model("config", configSchema, 'config');


Config.watch([], { fullDocument: "updateLookup" })
    .on("change", (change) => {
        switch (change.operationType) {
            case "insert":
            case "update":
            case "replace":
                io.emit("config:update", change.fullDocument);
                break;

            case "delete":
                io.emit("config:delete", change.documentKey._id);
                break;
        }
    });

module.exports = Config;
