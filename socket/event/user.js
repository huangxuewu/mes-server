const md5 = require("md5");
const db = require("../../models");
const { getActiveSessionUser, publicUser, privateUser } = require('../session');

// Password hashing salt (must match frontend)
const PASSWORD_SALT = 'MANUFACTURING_EXECUTION_SYSTEM';

const MD5_PATTERN = /^[a-f0-9]{32}$/i;
const ID_PATTERN = /^[a-f0-9]{24}$/i;
const PROFILE_FIELDS = ['displayName', 'portrait', 'phone', 'email'];
const ACCOUNT_FIELDS = [...PROFILE_FIELDS, 'username', 'password', 'confirmPassword', 'role', 'status', 'permission', 'group'];
const PERMISSION_FIELDS = ['module', 'access', 'create', 'view', 'update', 'modify', 'edit', 'delete', 'approve', 'override', 'export', 'audit'];

const validatePayload = (data, fields) => {
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid account payload');
    for (const [key, value] of Object.entries(data)) {
        if (!fields.includes(key)) throw new Error(`Field not allowed: ${key}`);
        if (key === 'permission') {
            if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid permissions');
            for (const [action, resources] of Object.entries(value)) {
                if (!PERMISSION_FIELDS.includes(action) || !Array.isArray(resources) || resources.some(resource => typeof resource !== 'string')) throw new Error('Invalid permissions');
            }
        } else if (typeof value !== 'string') throw new Error(`Invalid ${key}`);
    }
    if (data._id && !ID_PATTERN.test(data._id)) throw new Error('Invalid account ID');
    if (data.status && !['Active', 'Inactive', 'Disabled', 'Deleted'].includes(data.status)) throw new Error('Invalid account status');
};

const normalizeUserPayload = (payload = {}) => {
    const normalizedPayload = { ...payload };

    delete normalizedPayload.confirmPassword;
    if (normalizedPayload.password === '') delete normalizedPayload.password;

    if (typeof normalizedPayload.password === "string" && normalizedPayload.password.length > 0 && !MD5_PATTERN.test(normalizedPayload.password)) {
        normalizedPayload.password = md5(normalizedPayload.password + PASSWORD_SALT);
    }

    return normalizedPayload;
};

module.exports = (socket, io) => {
    const on = (event, action) => socket.on(event, (data, callback) => {
        const generation = socket.data.sessionGeneration;
        return action(data, result => callback?.(generation === socket.data.sessionGeneration && socket.data.expiresAt > Date.now()
            ? result : { status: 'error', message: 'Session changed. Sign in again.' }));
    });
    on("user:create", async (data, callback) => {
        try {
            const actor = await getActiveSessionUser(socket);
            if (actor.role !== 'System') throw new Error('Account administration requires System access');
            validatePayload(data, ACCOUNT_FIELDS);
            if (!data.username?.trim() || !data.password) throw new Error('Username and password are required');
            await db.user.create(normalizeUserPayload(data));
            callback({ status: "success", message: "User created successfully" });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    })

    on("user:update", async (payload, callback) => {
        try {
            const actor = await getActiveSessionUser(socket);
            const isSelf = String(actor._id) === payload?._id;
            if (actor.role !== 'System' && !isSelf) throw new Error('Account administration requires System access');
            validatePayload(payload, ['_id', ...(actor.role === 'System' ? ACCOUNT_FIELDS : PROFILE_FIELDS)]);
            if (!ID_PATTERN.test(payload._id || '')) throw new Error('Invalid account ID');
            const { _id, ...update } = payload;
            await db.user.updateOne({ _id }, { $set: normalizeUserPayload(update) }, { runValidators: true });
            callback({ status: "success", message: "User updated successfully" });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    })

    on("user:delete", async (data, callback) => {
        try {
            const actor = await getActiveSessionUser(socket);
            if (actor.role !== 'System') throw new Error('Account administration requires System access');
            validatePayload(data, ['_id']);
            if (!ID_PATTERN.test(data._id || '')) throw new Error('Invalid account ID');
            await db.user.deleteOne({ _id: data._id });
            callback({ status: "success", message: "User deleted successfully" });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    })

    on("user:get", async (data, callback) => {
        try {
            const actor = await getActiveSessionUser(socket);
            validatePayload(data, ['_id']);
            if (!ID_PATTERN.test(data._id || '')) throw new Error('Invalid account ID');
            const user = await db.user.findOne({ _id: data._id }).lean();
            const safe = user && (actor.role === 'System' || String(actor._id) === data._id ? privateUser(user) : publicUser(user));
            callback({ status: "success", message: "User fetched successfully", payload: safe });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    })

    on("users:get", async (data, callback) => {
        try {
            const actor = await getActiveSessionUser(socket);
            validatePayload(data || {}, ['status', 'role', 'group']);
            const users = await db.user.find(data || {}).lean();
            const safe = users.map(user => actor.role === 'System' || String(actor._id) === String(user._id) ? privateUser(user) : publicUser(user));
            callback({ status: "success", message: "Users fetched successfully", payload: safe });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    })
}
