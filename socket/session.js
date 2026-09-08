const JWT_SECRET = process.env.JWT_SECRET || (process.env.NODE_ENV === 'production' ? null : 'EMS');
const { createHash } = require('node:crypto');
const boundSessions = new Map();
const sessionEndListeners = new Set();
const onSessionEnded = callback => sessionEndListeners.add(callback);
const permissionChangeListeners = new Set();
const onPermissionsChanged = callback => permissionChangeListeners.add(callback);
const isBoundDocumentSession = (socketId, userId, generation) => {
    const session = boundSessions.get(socketId);
    return Boolean(session && session.userId === String(userId) && session.expiresAt > Date.now()
        && (generation === undefined || generation === session.generation));
};

// Room joined by sockets whose user holds office.calendar.event.public.view,
// so public calendar events can be broadcast without enumerating users.
const PUBLIC_EVENT_ROOM = "calendar:publicEvent";

const PUBLIC_EVENT_VIEW_PERM = "office.calendar.event.public.view";

const userRoom = (userId) => `user:${String(userId)}`;

const getSessionUserId = (socket) => socket.data?.userId ?? null;

const hasPermission = (user, action, resource) => {
    if (!user) return false;
    // Admin is the highest operator role; System is reserved for MES service actions.
    if (['Admin', 'System'].includes(user.role)) return true;
    const perms = user.permission?.[action];
    return Array.isArray(perms) && perms.includes(resource);
};

const sessionSignature = user => createHash('sha256').update(JSON.stringify({
    username: user.username || '', password: user.password || '', role: user.role || '', status: user.status || '',
    permission: Object.fromEntries(['module', 'access', 'create', 'view', 'update', 'modify', 'edit', 'delete', 'approve', 'override', 'export', 'audit']
        .map(action => [action, [...(user.permission?.[action] || [])].sort()])),
})).digest('hex');

const authenticationSignature = user => createHash('sha256').update(JSON.stringify({
    username: user.username || '', password: user.password || '', role: user.role || '', status: user.status || '',
})).digest('hex');

const bindSocketSession = (socket, user, expiresAt = Date.now() + 10 * 60 * 60 * 1000) => {
    unbindSocketSession(socket);
    socket.data.userId = String(user._id);
    socket.data.expiresAt = expiresAt;
    socket.data.sessionSignature = sessionSignature(user);
    socket.data.authenticationSignature = authenticationSignature(user);
    boundSessions.set(socket.id, { userId: String(user._id), expiresAt, generation: socket.data.sessionGeneration });
    socket.data.expiryTimer = setTimeout(() => {
        unbindSocketSession(socket);
        socket.emit('auth:revoked', { reason: 'Session expired' });
    }, Math.max(0, expiresAt - Date.now()));
    socket.data.expiryTimer.unref?.();
    socket.join(userRoom(user._id));
    if (hasPermission(user, "view", PUBLIC_EVENT_VIEW_PERM))
        socket.join(PUBLIC_EVENT_ROOM);
};

const unbindSocketSession = (socket) => {
    boundSessions.delete(socket.id);
    for (const notify of sessionEndListeners) notify(socket.id);
    socket.data.sessionGeneration = (socket.data.sessionGeneration || 0) + 1;
    if (socket.data.expiryTimer) clearTimeout(socket.data.expiryTimer);
    if (socket.data.userId) socket.leave(userRoom(socket.data.userId));
    socket.leave(PUBLIC_EVENT_ROOM);
    socket.data.userId = null;
    socket.data.expiresAt = null;
    socket.data.sessionSignature = null;
    socket.data.authenticationSignature = null;
    socket.data.expiryTimer = null;
    socket.data.messageTopics = new Set();
    socket.data.documentGrants = {};
    socket.data.documentSeen = new Set();
};

const canAdministerAccounts = user => user?.role === 'Admin';
const canManageAccount = (actor, target) => Boolean(target &&
    actor?.role === 'Admin' && target.role !== 'System');

const getActiveSessionUser = async socket => {
    const id = getSessionUserId(socket);
    const generation = socket.data.sessionGeneration;
    if (!id || !socket.data.expiresAt || socket.data.expiresAt <= Date.now()) {
        unbindSocketSession(socket);
        throw new Error('Sign in to continue');
    }
    const user = await require('../models').user.findById(id).lean();
    if (getSessionUserId(socket) !== id || socket.data.sessionGeneration !== generation) throw new Error('Session changed');
    if (!user || user.status !== 'Active' || authenticationSignature(user) !== socket.data.authenticationSignature) {
        unbindSocketSession(socket);
        socket.emit('auth:revoked', { reason: 'Account access changed. Sign in again.' });
        throw new Error('Session no longer valid');
    }
    const signature = sessionSignature(user);
    if (signature !== socket.data.sessionSignature) {
        socket.data.sessionSignature = signature;
        hasPermission(user, 'view', PUBLIC_EVENT_VIEW_PERM) ? socket.join(PUBLIC_EVENT_ROOM) : socket.leave(PUBLIC_EVENT_ROOM);
        for (const notify of permissionChangeListeners) notify(socket.id);
        socket.emit('auth:permissions', privateUser(user));
    }
    return user;
};

const publicUser = user => Object.fromEntries(
    ['_id', 'username', 'displayName', 'portrait', 'role', 'status'].map(key => [key, user[key]])
);
const privateUser = user => {
    const { password, ...safe } = user.toObject ? user.toObject() : user;
    return safe;
};

module.exports = {
    JWT_SECRET,
    PUBLIC_EVENT_ROOM,
    userRoom,
    getSessionUserId,
    hasPermission,
    canAdministerAccounts,
    canManageAccount,
    bindSocketSession,
    unbindSocketSession,
    getActiveSessionUser,
    sessionSignature,
    onSessionEnded,
    onPermissionsChanged,
    isBoundDocumentSession,
    publicUser,
    privateUser,
};
