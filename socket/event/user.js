const md5 = require("md5");
const db = require("../../models");
const { claimUsername } = require('../../utils/userAccount');
const { getActiveSessionUser, publicUser, privateUser, canAdministerAccounts, canManageAccount, resolveUserPermissions } = require('../session');

// Password hashing salt (must match frontend)
const PASSWORD_SALT = 'MANUFACTURING_EXECUTION_SYSTEM';

const MD5_PATTERN = /^[a-f0-9]{32}$/i;
const ID_PATTERN = /^[a-f0-9]{24}$/i;
const PROFILE_FIELDS = ['displayName', 'portrait', 'phone', 'email', 'signatures', 'defaultSignatureId'];
const ACCOUNT_FIELDS = [...PROFILE_FIELDS, 'username', 'password', 'confirmPassword', 'role', 'status', 'permission', 'permissionCategoryId', 'group'];
const PERMISSION_FIELDS = ['module', 'access', 'create', 'view', 'update', 'modify', 'edit', 'delete', 'approve', 'override', 'export', 'audit'];

const validatePayload = (data, fields) => {
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid account payload');
    for (const [key, value] of Object.entries(data)) {
        if (!fields.includes(key)) throw new Error(`Field not allowed: ${key}`);
        if (key === 'signatures') {
            if (!Array.isArray(value) || value.length > 2 || JSON.stringify(value).length > 768 * 1024) throw new Error('Invalid signature collection (maximum 2 signatures)');
            const ids = new Set();
            for (const signature of value) {
                if (!signature || typeof signature !== 'object' || Object.keys(signature).some(field => !['id', 'image'].includes(field))) throw new Error('Invalid signature');
                if (typeof signature.id !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(signature.id) || ids.has(signature.id)) throw new Error('Invalid signature ID');
                if (typeof signature.image !== 'string' || signature.image.length > 256 * 1024 || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(signature.image)) throw new Error('Invalid signature image');
                const png = Buffer.from(signature.image.slice(22), 'base64');
                if (png.length < 24 || png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || png.toString('ascii', 12, 16) !== 'IHDR'
                    || !png.readUInt32BE(16) || !png.readUInt32BE(20) || png.readUInt32BE(16) > 4096 || png.readUInt32BE(20) > 4096) throw new Error('Invalid signature image');
                ids.add(signature.id);
            }
        } else if (key === 'permission') {
            if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid permissions');
            for (const [action, resources] of Object.entries(value)) {
                if (!PERMISSION_FIELDS.includes(action) || !Array.isArray(resources) || resources.some(resource => typeof resource !== 'string')) throw new Error('Invalid permissions');
            }
        } else if (typeof value !== 'string') throw new Error(`Invalid ${key}`);
    }
    if (data._id && !ID_PATTERN.test(data._id)) throw new Error('Invalid account ID');
    if (data.status && !['Active', 'Inactive', 'Disabled', 'Deleted'].includes(data.status)) throw new Error('Invalid account status');
    if (data.role === 'System') throw new Error('System is reserved for MES records and cannot be assigned to an operator');
    if (data.role && !['Admin', 'Manager', 'User'].includes(data.role)) throw new Error('Invalid account role');
    if ('signatures' in data || 'defaultSignatureId' in data) {
        if (!Array.isArray(data.signatures) || typeof data.defaultSignatureId !== 'string') throw new Error('Signatures and default must be updated together');
        if (data.defaultSignatureId && !data.signatures.some(signature => signature.id === data.defaultSignatureId)) throw new Error('Default signature not found');
    }
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

const validatePermissionCategory = async (payload, target) => {
    if ('permissionCategoryId' in payload) {
        const id = payload.permissionCategoryId;
        if (id && (!ID_PATTERN.test(id) || !await db.permissionCategory.findById(id).lean())) throw new Error('Permission category not found');
        if (id && 'permission' in payload) throw new Error('Configure permissions on the permission category');
        // Personal permissions must be explicitly supplied when leaving a category.
        if (id || !('permission' in payload)) payload.permission = {};
    } else if (target?.permissionCategoryId && 'permission' in payload) {
        throw new Error('Configure permissions on the permission category');
    }
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
            if (!canAdministerAccounts(actor)) throw new Error('Account administration requires Admin access');
            validatePayload(data, ACCOUNT_FIELDS);
            if (!data.username?.trim() || !data.password) throw new Error('Username and password are required');
            await validatePermissionCategory(data);
            const username = await claimUsername(db.user, data.username);
            await db.user.create({ ...normalizeUserPayload(data), ...username });
            callback({ status: "success", message: "User created successfully" });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    })

    on("user:update", async (payload, callback) => {
        try {
            const actor = await getActiveSessionUser(socket);
            const isSelf = String(actor._id) === payload?._id;
            if (!canAdministerAccounts(actor) && !isSelf) throw new Error('Account administration requires Admin access');
            validatePayload(payload, ['_id', ...(canAdministerAccounts(actor) ? ACCOUNT_FIELDS : PROFILE_FIELDS)]);
            if (!ID_PATTERN.test(payload._id || '')) throw new Error('Invalid account ID');
            const target = await db.user.findById(payload._id).lean();
            if (!target) throw new Error('Account not found');
            if (target.role === 'System') throw new Error('System records are managed by MES');
            await validatePermissionCategory(payload, target);
            const { _id, ...update } = payload;
            if ('username' in update) Object.assign(update, await claimUsername(db.user, update.username, _id));
            const filter = { _id, role: { $ne: 'System' } };
            const result = await db.user.updateOne(filter, { $set: normalizeUserPayload(update) }, { runValidators: true });
            if (!result.matchedCount) throw new Error('Account changed. Refresh and try again.');
            callback({ status: "success", message: "User updated successfully" });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    })

    on("user:delete", async (data, callback) => {
        try {
            const actor = await getActiveSessionUser(socket);
            if (!canAdministerAccounts(actor)) throw new Error('Account administration requires Admin access');
            validatePayload(data, ['_id']);
            if (!ID_PATTERN.test(data._id || '')) throw new Error('Invalid account ID');
            const target = await db.user.findById(data._id).lean();
            if (!canManageAccount(actor, target)) throw new Error('System records are managed by MES');
            await db.user.deleteOne({ _id: data._id, role: { $ne: 'System' } });
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
            const user = await resolveUserPermissions(await db.user.findOne({ _id: data._id }).lean());
            const safe = user && (canManageAccount(actor, user) || String(actor._id) === data._id ? privateUser(user) : publicUser(user));
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
            const safe = await Promise.all(users.map(async user => canManageAccount(actor, user) || String(actor._id) === String(user._id)
                ? privateUser(await resolveUserPermissions(user)) : publicUser(user)));
            callback({ status: "success", message: "Users fetched successfully", payload: safe });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    })
}
