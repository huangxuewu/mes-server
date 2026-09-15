const mongoose = require('mongoose');
const database = require('../config/database');

const schema = new mongoose.Schema({
    _id: String,
    revision: { type: Number, default: 0 },
    labeled: { type: Boolean, default: false },
    inspected: { type: Boolean, default: false },
    labeledEvent: Number,
    inspectedEvent: Number,
}, { timestamps: true });

module.exports = database.model('OutboundWorkflowState', schema, 'outboundWorkflowState');
