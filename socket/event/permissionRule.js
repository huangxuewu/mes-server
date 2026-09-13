const db = require('../../models');
const { getActiveSessionUser, canAdministerAccounts } = require('../session');
const { refreshPermissionRules } = require('../userDelivery');

const ACTIONS = ['module', 'access', 'create', 'view', 'update', 'modify', 'edit', 'delete', 'approve', 'override', 'export', 'audit'];

module.exports = (socket, io) => {
    for (const event of ['permissionRules:get', 'permissionRule:create', 'permissionRule:update']) {
        socket.on(event, async (data, callback) => {
            const generation = socket.data.sessionGeneration;
            const reply = result => callback?.(generation === socket.data.sessionGeneration && socket.data.expiresAt > Date.now()
                ? result : { status: 'error', message: 'Session changed. Sign in again.' });
            try {
                const actor = await getActiveSessionUser(socket);
                if (!canAdministerAccounts(actor)) throw new Error('Account administration requires Admin access');
                if (event === 'permissionRules:get') {
                    const rules = await db.permissionRule.find({}).sort({ name: 1 }).lean();
                    return reply({ status: 'success', payload: rules });
                }
                if (!data || typeof data !== 'object' || Array.isArray(data)
                    || Object.keys(data).some(key => !['name', 'permission', ...(event.endsWith(':update') ? ['_id'] : [])].includes(key))) throw new Error('Invalid permission rule');
                if (typeof data.name !== 'string' || !data.name.trim() || data.name.trim().length > 80) throw new Error('Permission rule name is required (maximum 80 characters)');
                if (!data.permission || typeof data.permission !== 'object' || Array.isArray(data.permission)) throw new Error('Invalid permissions');
                for (const [action, resources] of Object.entries(data.permission)) {
                    if (!ACTIONS.includes(action) || !Array.isArray(resources) || resources.some(resource => typeof resource !== 'string' || !resource.trim())) throw new Error('Invalid permissions');
                }
                const update = { name: data.name.trim(), permission: Object.fromEntries(ACTIONS.map(action => [action, [...new Set(data.permission[action] || [])]])) };
                let rule;
                if (event === 'permissionRule:create') {
                    rule = await db.permissionRule.create(update);
                } else {
                    if (typeof data._id !== 'string' || !/^[a-f0-9]{24}$/i.test(data._id)) throw new Error('Invalid permission rule ID');
                    rule = await db.permissionRule.findOneAndUpdate({ _id: data._id }, { $set: update }, { new: true, runValidators: true }).lean();
                    if (!rule) throw new Error('Permission rule not found');
                }
                await refreshPermissionRules(io);
                reply({ status: 'success', payload: rule });
            } catch (error) {
                reply({ status: 'error', message: error.code === 11000 ? 'A permission rule with this name already exists' : error.message });
            }
        });
    }
};
