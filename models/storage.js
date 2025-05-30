const mongoose = require("mongoose");
const { io } = require("../socket/io");
const database = require("../config/database");

const storageSchema = new mongoose.Schema({
    type: {
        type: String,
        enum: ['Pallet', 'Box', 'Bag', 'Container', 'Floor', 'Other'],
        default: 'Pallet',
        required: true
    },
    location: {
        zone: {
            type: String,
            enum: ['Bay 1', 'Bay 2', 'Bay 3', 'Bay 4', 'Office Storage Room', 'Machine Room', 'Other'],
            default: 'Bay 4'
        },
        aisle: {
            type: Number,
            default: ""
        },
        rack: {
            type: String,
            default: ""
        },
        level: {
            type: Number,
            default: ""
        },
        position: {
            type: String,
            default: ""
        }

    },
    contents: [{
        inventoryId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Inventory'
        },
        sku: {
            type: String,
            default: ""
        },
        quantity: {
            type: Number,
            default: 0
        }
    }],
    lotNumber: {
        type: String,
        default: ""
    },
    batchNumber: {
        type: String,
        default: ""
    },
    expiryDate: {
        type: Date,
        default: null
    },
    receive: {
        date: {
            type: Date,
            default: null
        },
        by: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User'
        },
        from: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Supplier'
        }
    },
    lastMoved: {
        date: {
            type: Date,
            default: null
        },
        by: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User'
        },
        from: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Storage'
        },
        to: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Storage'
        }
    },
    note: {
        type: String,
        default: ""
    },
}, { timestamps: true });

const Storage = mongoose.model("Storage", storageSchema, 'storage');

Storage.watch([], { fullDocument: "updateLookup" })
    .on("change", (change) => {

        switch (change.operationType) {
            case "insert":
            case "update":
            case "replace":
                io.emit("storage:update", change.fullDocument);
                break;
            case "delete":
                io.emit("storage:delete", change.documentKey._id);
                break;
        }
    })

module.exports = Storage;