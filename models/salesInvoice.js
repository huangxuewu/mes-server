const mongoose = require('mongoose');
const database = require('../config/database');

const schema = new mongoose.Schema({
    integrationKey: { type: String, required: true },
    poNumber: { type: String, required: true },
    invoiceNumber: String,
    invoiceDate: String,
    submissionStartedAt: Date,
    submittedBy: String,
    submittedMessage: mongoose.Schema.Types.Mixed,
    transactionId: String,
    transactionJson: mongoose.Schema.Types.Mixed,
    validationStatus: String,
    deliveryStatus: String,
    acknowledgmentStatus: String,
    pdfPath: String,
    pdfSavedAt: Date,
    pdfSourceHash: String,
}, { timestamps: true });
schema.index({ integrationKey: 1, poNumber: 1 }, { unique: true });
module.exports = database.model('salesInvoice', schema, 'salesInvoice');
