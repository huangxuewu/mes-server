const mongoose = require('mongoose');
const database = require('../config/database');
const schema = new mongoose.Schema({
    topicId: { type: mongoose.Schema.Types.ObjectId, required: true },
    ownerId: { type: mongoose.Schema.Types.ObjectId, required: true },
    clientRequestId: { type: String, required: true },
    filename: String, mime: String, type: String, size: Number, storagePath: String,
    requestHash: String, uploadSessionId: String, offset: { type: Number, default: 0 },
    pendingOffset: Number, pendingSize: Number, pendingHash: String,
    status: { type: String, enum: ['Staged', 'Ready', 'Attached', 'Removed'], default: 'Staged' },
    messageId: mongoose.Schema.Types.ObjectId, messageRequestId: String,
    expiresAt: Date,
}, { timestamps: true });
schema.index({ ownerId: 1, clientRequestId: 1 }, { unique: true });
schema.index({ status: 1, expiresAt: 1 });
module.exports = database.model('MessageAttachment', schema, 'messageAttachment');
