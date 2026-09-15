const mongoose = require('mongoose');
const database = require('../config/database');

const schema = new mongoose.Schema({
    _id: Number,
    loadNumber: { type: String, required: true },
    stage: { type: String, enum: ['labeled', 'inspected'], required: true },
    createdAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true, index: { expires: 0 } },
});

module.exports = database.model('SignaturePadNotification', schema, 'signaturePadNotification');
