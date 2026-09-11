const mongoose = require('mongoose');
const database = require('../config/database');

const widgetSchema = new mongoose.Schema({
    id: { type: String, required: true },
    type: { type: String, required: true },
    size: { type: String, enum: ['small', 'medium', 'large'], required: true },
    x: { type: Number, required: true },
    y: { type: Number, required: true },
    settings: { type: mongoose.Schema.Types.Mixed, default: {} },
}, { _id: false });

module.exports = database.model('Dashboard', new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, required: true, unique: true },
    version: { type: Number, default: 1 },
    widgets: { type: [widgetSchema], default: [] },
}, { timestamps: true }), 'dashboard');
