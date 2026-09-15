const mongoose = require('mongoose');
const database = require('../config/database');

const schema = new mongoose.Schema({
    _id: String,
    action: String,
    loadNumber: String,
    shipments: [{ _id: false, shipmentId: String, status: Boolean, timestamp: Date }],
    completedIds: [String],
    signatureHash: String,
    releaseRequired: Boolean,
    expiresAt: { type: Date, required: true, index: { expires: 0 } },
});

module.exports = database.model('SignaturePadWorkflowReceipt', schema, 'signaturePadWorkflowReceipt');
