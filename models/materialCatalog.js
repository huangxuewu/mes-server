const mongoose = require("mongoose");
const { io } = require("../socket/io");
const database = require("../config/database");

const materialCatalogSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        trim: true,
        index: true
    },
    code: {
        type: String,
        trim: true,
        index: true
    },
    category: {
        type: String,
        trim: true,
        index: true
    },
    description: {
        type: String,
        trim: true
    },
    materialIds: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'material'
    }],
    status: {
        type: String,
        enum: ['Active', 'Inactive'],
        default: 'Active',
        index: true
    },
    notes: {
        type: String,
        trim: true
    }
}, { timestamps: true });

const MaterialCatalog = database.model("materialCatalog", materialCatalogSchema, "materialCatalog");

MaterialCatalog.watch([], { fullDocument: "updateLookup" })
    .on("change", (change) => {
        switch (change.operationType) {
            case "insert":
            case "update":
            case "replace":
                io.emit("materialCatalog:update", change.fullDocument);
                break;
            case "delete":
                io.emit("materialCatalog:delete", change.documentKey._id);
                break;
        }
    });

module.exports = MaterialCatalog;
