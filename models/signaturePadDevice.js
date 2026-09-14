const mongoose = require('mongoose');
const database = require('../config/database');

const schema = new mongoose.Schema({
    _id: { type: String, required: true },
    ownerId: { type: String, required: true },
    tokenHash: { type: String, required: true, index: true },
    revoked: { type: Boolean, default: false },
}, { timestamps: true });

module.exports = database.model('SignaturePadDevice', schema, 'signaturePadDevice');
