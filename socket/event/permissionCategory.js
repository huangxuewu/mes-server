const db = require('../../models');
const { getActiveSessionUser, canAdministerAccounts } = require('../session');
const { refreshPermissionCategories } = require('../userDelivery');

const ACTIONS = ['module', 'access', 'create', 'view', 'update', 'modify', 'edit', 'delete', 'approve', 'override', 'export', 'audit'];

module.exports = (socket, io) => {
    for (const event of ['permissionCategories:get', 'permissionCategory:create', 'permissionCategory:update']) {
        socket.on(event, async (data, callback) => {
            const generation = socket.data.sessionGeneration;
            const reply = result => callback?.(generation === socket.data.sessionGeneration && socket.data.expiresAt > Date.now()
                ? result : { status: 'error', message: 'Session changed. Sign in again.' });
            try {
                const actor = await getActiveSessionUser(socket);
                if (!canAdministerAccounts(actor)) throw new Error('Account administration requires Admin access');
                if (event === 'permissionCategories:get') {
                    const categories = await db.permissionCategory.find({}).sort({ name: 1 }).lean();
                    return reply({ status: 'success', payload: categories });
                }
                if (!data || typeof data !== 'object' || Array.isArray(data)
                    || Object.keys(data).some(key => !['name', 'permission', ...(event.endsWith(':update') ? ['_id'] : [])].includes(key))) throw new Error('Invalid permission category');
                if (typeof data.name !== 'string' || !data.name.trim() || data.name.trim().length > 80) throw new Error('Permission category name is required (maximum 80 characters)');
                if (!data.permission || typeof data.permission !== 'object' || Array.isArray(data.permission)) throw new Error('Invalid permissions');
                for (const [action, resources] of Object.entries(data.permission)) {
                    if (!ACTIONS.includes(action) || !Array.isArray(resources) || resources.some(resource => typeof resource !== 'string' || !resource.trim())) throw new Error('Invalid permissions');
                }
                const update = { name: data.name.trim(), permission: Object.fromEntries(ACTIONS.map(action => [action, [...new Set(data.permission[action] || [])]])) };
                let category;
                if (event === 'permissionCategory:create') {
                    category = await db.permissionCategory.create(update);
                } else {
                    if (typeof data._id !== 'string' || !/^[a-f0-9]{24}$/i.test(data._id)) throw new Error('Invalid permission category ID');
                    category = await db.permissionCategory.findOneAndUpdate({ _id: data._id }, { $set: update }, { new: true, runValidators: true }).lean();
                    if (!category) throw new Error('Permission category not found');
                }
                await refreshPermissionCategories(io);
                reply({ status: 'success', payload: category });
            } catch (error) {
                reply({ status: 'error', message: error.code === 11000 ? 'A permission category with this name already exists' : error.message });
            }
        });
    }
};
