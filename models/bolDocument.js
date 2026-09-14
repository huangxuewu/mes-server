const mongoose = require('mongoose');
const database = require('../config/database');

const schema = new mongoose.Schema({
    loadNumber: { type: String, default: '' },
    shipmentId: { type: String, default: '' },
    number: { type: String, default: '' },
    url: { type: String, default: '' },
    uploadedAt: { type: Date, default: null },
    rawData: { type: mongoose.Schema.Types.Mixed, default: null },
    revision: { type: Number, default: 0 },
    migrationKey: String,
}, { timestamps: true, strict: false });
schema.index({ number: 1 });
schema.index({ loadNumber: 1 }, { unique: true, partialFilterExpression: { loadNumber: { $gt: '' } } });
schema.index({ shipmentId: 1 }, { unique: true, partialFilterExpression: { loadNumber: '', shipmentId: { $gt: '' } } });
schema.index({ migrationKey: 1 }, { unique: true, sparse: true });

module.exports = database.model('bolDocument', schema, 'bolDocument');
