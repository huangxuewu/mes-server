const claimUsername = async (User, value, excludeId = null, session = null) => {
    if (typeof value !== 'string' || !value.trim()) throw new Error('Username is required');
    const username = value.trim();
    const escaped = username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const filter = { username: { $regex: `^${escaped}$`, $options: 'i' } };
    if (excludeId) filter._id = { $ne: excludeId };
    const query = User.findOne(filter);
    if (session) query.session(session);
    if (await query.lean()) throw new Error('Username is already in use');
    return { username, usernameKey: username.toLowerCase() };
};

const { randomBytes, scrypt, timingSafeEqual } = require('node:crypto');
const { promisify } = require('node:util');
const deriveKey = promisify(scrypt);

const hashLoginPassword = async digest => {
    const salt = randomBytes(16).toString('hex');
    const key = await deriveKey(digest, salt, 64);
    return `scrypt$${salt}$${key.toString('hex')}`;
};

const verifyLoginPassword = async (stored, digest) => {
    if (typeof stored !== 'string' || typeof digest !== 'string') return false;
    if (!stored.startsWith('scrypt$')) return stored === digest;
    const [, salt, hash] = stored.split('$');
    if (!/^[a-f\d]{32}$/.test(salt || '') || !/^[a-f\d]{128}$/.test(hash || '')) return false;
    const actual = await deriveKey(digest, salt, 64);
    return timingSafeEqual(actual, Buffer.from(hash, 'hex'));
};

module.exports = { claimUsername, hashLoginPassword, verifyLoginPassword };
