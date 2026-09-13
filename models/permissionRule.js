const mongoose = require('mongoose');
const database = require('../config/database');
const { io } = require('../socket/io');

const permissionRuleSchema = new mongoose.Schema({
    name: { type: String, required: true, trim: true, maxlength: 80, unique: true },
    permission: Object.fromEntries(['module', 'access', 'create', 'view', 'update', 'modify', 'edit', 'delete', 'approve', 'override', 'export', 'audit']
        .map(action => [action, [String]])),
}, { timestamps: true });

// Existing documents live in the permissionCategory collection.
const PermissionRule = database.model('PermissionRule', permissionRuleSchema, 'permissionCategory');

PermissionRule.watch().on('change', () => {
    const { refreshPermissionRules } = require('../socket/userDelivery');
    refreshPermissionRules(io).catch(error => console.error('Permission rule delivery failed:', error.message));
});

module.exports = PermissionRule;
