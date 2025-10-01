const mongoose = require("mongoose");
const { io } = require("../socket/io");
const database = require("../config/database");

const itemSchema = new mongoose.Schema({
    upc: String,
    quantity: Number,
    casePack: Number,
    styleCode: String,
    description: String,
},);

const auditLogSchema = new mongoose.Schema({
    action: { type: String, default: null, enum: ["create", "update", "delete"] },
    changes: [{
        field: { type: String, default: null },
        oldValue: { type: String, default: null },
        newValue: { type: String, default: null },
    }],
    createdAt: { type: Date, default: null },
    createdBy: { type: String, default: null },
});

const loadSchema = new mongoose.Schema({
    pickupDate: { type: String, default: null, description: "Date Ship IQ assigned for pickup" },
    pickupGate: { type: String, default: null, description: "Gate code for pickup" },
    onPremisesDate: { type: String, default: null, description: "Date buyer expected shipment to be on their premises" },
    schedulePickupAt: { type: Date, default: null, description: "Date carrier scheduled for pickup" },
    actualPickupAt: { type: Date, default: null, description: "Date carrier actually came to pickup the shipment" },
    shipmentId: { type: String, default: "" },
    loadNumber: { type: String, default: "" },
    proNumber: { type: String, default: "" },
    assignedSCAC: { type: String, default: "" },
    executingSCAC: { type: String, default: "" },
    chRobinsonNumber: { type: String, default: "" },
    cube: { type: Number, default: 0 },
    weight: { type: Number, default: 0 },
    cartons: { type: Number, default: 0 },
    pallets: { type: Number, default: 0 },
    commodity: { type: String, default: "" },
    status: { type: String, default: "Pending" },
    bol: {
        url: { type: String, default: "" },
        number: { type: String, default: "" },
        uploadedAt: { type: Date, default: null },
        rawData: { type: Object, default: null },
    },
    items: mongoose.Mixed,
    auditLog: [auditLogSchema],
    checklist: {
        printed: {
            status: { type: Boolean, default: false, description: "Whether the shipping labels are printed" },
            timestamp: { type: Date, default: null },
        },
        picked: {
            status: { type: Boolean, default: false, description: "Whether all the boxes are picked and ready to be labeled" },
            timestamp: { type: Date, default: null },
        },
        labeled: {
            status: { type: Boolean, default: false, description: "Whether all the boxes are labeled" },
            timestamp: { type: Date, default: null },
        },
        loading: {
            status: { type: Boolean, default: false, description: "Whether the truck is here and shipment is loading" },
            timestamp: { type: Date, default: null },
        },
        loaded: {
            status: { type: Boolean, default: false, description: "Whether the shipment is completely loaded on the truck" },
            timestamp: { type: Date, default: null },
        },
    }
}, {
    _id: false,
    timestamps: true,
    transform: (doc, ret) => {
        if (ret?.items.length === 0)
            delete ret.items;

        return ret;
    }
});

const inboundSchema = new mongoose.Schema({
    masterPO: String,
    poNumber: { type: String, required: true },
    poDate: { type: String, default: null },
    client: { type: String, default: "Target" },
    name: String,
    address: String,
    city: String,
    state: String,
    zip: String,
    country: String,
    items: [itemSchema],
    loads: [loadSchema],
    shipWindow: {
        start: String,
        end: String
    }
}, {
    timestamps: true
});

const Inbound = database.model("shipment", inboundSchema, "shipment");

Inbound.createIndexes({
    "masterPO": 1,
    "poNumber": 1,
});

Inbound
    .watch([], { fullDocument: "updateLookup" })
    .on("change", (change) => {
        switch (change.operationType) {
            case "insert":
            case "update":
            case "replace":
                io.emit("outbound:update", change.fullDocument);

                break;
            case "delete":
                io.emit("outbound:delete", change.documentKey._id);
                break;
        }
    });

Inbound.getActiveLoads = async () => {
    const loads = await Inbound.aggregate([
        { $match: { "loads.status": { $in: ["Carrier Accepted, Awaiting Pickup", "Past Pickup"] } } },
        { $unwind: { path: "$loads", preserveNullAndEmptyArrays: true } },
        { $replaceRoot: { newRoot: { $mergeObjects: ["$$ROOT", "$loads"] } } },
        { $project: { loads: 0 } },
        { $group: { _id: "$loadNumber", loads: { $push: "$$ROOT" } } },
        { $project: { _id: 0, loadNumber: "$_id", loads: 1 } }
    ]);

    return loads;
};

module.exports = Inbound;


