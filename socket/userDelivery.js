const { getActiveSessionUser, getSessionUserId, unbindSocketSession, publicUser, privateUser, canManageAccount, canAdministerAccounts, resolveUserPermissions } = require('./session');

const deliverUserChange = async (io, event, record) => {
    const id = String(record?._id || record);
    if (event !== 'user:delete') record = await resolveUserPermissions(record);
    await Promise.all([...io.sockets.sockets.values()].map(async socket => {
        if (!getSessionUserId(socket)) return;
        if (event === 'user:delete' && getSessionUserId(socket) === id) {
            unbindSocketSession(socket);
            socket.emit('auth:revoked', { reason: 'Account removed' });
            return;
        }
        try {
            const actor = await getActiveSessionUser(socket);
            if (event === 'user:delete') return socket.emit(event, id);
            const safe = canManageAccount(actor, record) || String(actor._id) === id ? privateUser(record) : publicUser(record);
            socket.emit(event, safe);
        } catch {
            // Invalid sessions receive no roster or account data.
        }
    }));
};

const refreshPermissionCategories = async io => {
    await Promise.all([...io.sockets.sockets.values()].map(async socket => {
        if (!getSessionUserId(socket)) return;
        try {
            const actor = await getActiveSessionUser(socket);
            if (canAdministerAccounts(actor)) socket.emit('permissionCategories:changed');
        } catch {
            // Expired sessions must not receive configuration updates.
        }
    }));
};

const notifyRegistrationsChanged = async io => {
    await Promise.all([...io.sockets.sockets.values()].map(async socket => {
        if (!getSessionUserId(socket)) return;
        try {
            if (canAdministerAccounts(await getActiveSessionUser(socket))) socket.emit('userRegistrations:changed');
        } catch {
            // Registration details are only available to active administrators.
        }
    }));
};

module.exports = { deliverUserChange, refreshPermissionCategories, notifyRegistrationsChanged };
