const mongoose = require('mongoose');
const database = require('../config/database');

const schema = new mongoose.Schema({
    _id: { type: String, required: true }, // Four digits; MongoDB guarantees uniqueness across server processes.
    reservationId: { type: String, required: true, index: true },
    owner: { type: String, required: true },
    deviceId: { type: String, required: true },
    attempts: { type: Number, default: 0 },
    consumed: { type: Boolean, default: false },
    cancelled: { type: Boolean, default: false },
    expiresAt: { type: Date, required: true, expires: 0 },
});

module.exports = database.model('SignaturePadPairing', schema, 'signaturePadPairing');
