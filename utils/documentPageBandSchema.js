const mongoose = require('mongoose');

module.exports = new mongoose.Schema({
    enabled: { type: Boolean, default: false },
    hideFirstPage: { type: Boolean, default: false },
    left: { type: String, maxlength: 300, default: '' },
    center: { type: String, maxlength: 300, default: '' },
    right: { type: String, maxlength: 300, default: '' },
    fontSize: { type: Number, min: 7, max: 14, default: 9 },
    color: { type: String, match: /^#[a-f\d]{6}$/i, default: '#606060' },
    separator: { type: Boolean, default: true },
    offset: { type: Number, min: 0, max: 1.5, default: 0.3 },
    height: { type: Number, min: 0.25, max: 1.5, default: 0.35 },
}, { _id: false });
