const mongoose = require('mongoose');
const database = require('../config/database');
const schema = new mongoose.Schema({
    topicId: { type: mongoose.Schema.Types.ObjectId, required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, required: true },
    messageId: mongoose.Schema.Types.ObjectId,
    readAt: Date,
}, { timestamps: true });
schema.index({ topicId: 1, userId: 1 }, { unique: true });
module.exports = database.model('MessageRead', schema, 'messageRead');
