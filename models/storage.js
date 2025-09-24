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
        // Reference to the appropriate inventory collection
        inventoryId: {
            type: mongoose.Schema.Types.ObjectId,
            required: true
        },
        inventoryType: {
            type: String,
            required: true,
            enum: ['finishedGoods', 'rawMaterials', 'tools', 'accessories'],
            description: "Type of inventory collection this references"
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

// Add virtual to get the correct inventory model reference based on inventoryType
storageSchema.path('contents').schema.virtual('inventoryRef').get(function() {
    const models = {
        'finishedGoods': require('./finishedGoods'),
        'rawMaterials': require('./rawMaterials'),
        'tools': require('./tools'),
        'accessories': require('./accessories')
    };
    return models[this.inventoryType];
});

// Instance method to get inventory details for a content item
storageSchema.path('contents').schema.methods.getInventoryDetails = async function() {
    const Model = this.inventoryRef;
    return await Model.findById(this.inventoryId);
};

// Static method to get storage with populated inventory details
storageSchema.statics.getStorageWithInventory = async function(storageId) {
    const storage = await this.findById(storageId);
    if (!storage) return null;
    
    const populatedContents = await Promise.all(
        storage.contents.map(async (content) => {
            const inventoryDetails = await content.getInventoryDetails();
            return {
                ...content.toObject(),
                inventoryDetails
            };
        })
    );
    
    return {
        ...storage.toObject(),
        contents: populatedContents
    };
};

const Storage = database.model("Storage", storageSchema, 'storage');

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