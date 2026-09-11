const mongoose = require('mongoose');
const database = require('../config/database');

const schema = new mongoose.Schema({
    tokenHash: { type: String, required: true, unique: true, select: false },
    token: { type: String, select: false },
    expiresAt: { type: Date, required: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, required: true },
    status: { type: String, enum: ['Open', 'Submitted', 'Approved', 'Rejected'], default: 'Open', index: true },
    displayName: String,
    email: String,
    username: String,
    password: { type: String, select: false },
    portrait: String,
    submittedAt: Date,
    reviewedAt: Date,
    reviewedBy: mongoose.Schema.Types.ObjectId,
    userId: mongoose.Schema.Types.ObjectId,
}, { timestamps: true });

module.exports = database.model('UserRegistration', schema, 'userRegistration');
