const mongoose = require("mongoose");
const database = require("../config/database");

const productionSettingSchema = new mongoose.Schema({
    rangeStart: { type: String, required: true },
    rangeEnd: { type: String, required: true },
    anchorOrderId: { type: mongoose.Schema.Types.ObjectId, ref: 'order', default: null },
    disabledPOs: { type: [String], default: [] },
    bufferRates: { type: mongoose.Schema.Types.Mixed, default: {} },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'user', default: null },
}, {
    timestamps: true,
});

productionSettingSchema.index({ rangeStart: 1, rangeEnd: 1 }, { unique: true });

module.exports = database.model("productionSetting", productionSettingSchema, "productionSetting");
