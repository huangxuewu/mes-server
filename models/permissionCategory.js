const mongoose = require('mongoose');
const database = require('../config/database');
const { io } = require('../socket/io');

const permissionCategorySchema = new mongoose.Schema({
    name: { type: String, required: true, trim: true, maxlength: 80, unique: true },
    permission: Object.fromEntries(['module', 'access', 'create', 'view', 'update', 'modify', 'edit', 'delete', 'approve', 'override', 'export', 'audit']
        .map(action => [action, [String]])),
}, { timestamps: true });

const PermissionCategory = database.model('PermissionCategory', permissionCategorySchema, 'permissionCategory');

PermissionCategory.watch().on('change', () => {
    const { refreshPermissionCategories } = require('../socket/userDelivery');
    refreshPermissionCategories(io).catch(error => console.error('Permission category delivery failed:', error.message));
});

module.exports = PermissionCategory;
