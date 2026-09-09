const { createHash } = require('node:crypto');
const { isIP } = require('node:net');
const axios = require('axios');

const createRegionLocator = ({ db, http = axios, env = process.env, now = Date.now } = {}) => {
    const cache = new Map();
    return async socket => {
        // Only the trusted Heroku router may supply a forwarded client address.
        const forwarded = env.DYNO ? socket.handshake.headers['x-forwarded-for']?.split(',').at(-1)?.trim() : null;
        const ip = String(forwarded || socket.handshake.address || '').replace(/^::ffff:/, '');
        if (!isIP(ip) || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|::1$|f[cd]|fe80:)/i.test(ip)) return null;
        try {
            const at = new Date(now());
            const records = await (db || require('../models')).config.find({
                key: { $in: ['integration.ipinfo.token'] },
                scope: 'Global', status: 'Active', 'effective.from': { $lte: at },
                $or: [{ 'effective.to': null }, { 'effective.to': { $gte: at } }],
            }, { key: 1, value: 1 }).maxTimeMS(1500).lean();
            const config = Object.fromEntries(records.map(({ key, value }) => [key, String(value ?? '').trim()]));
            const token = config['integration.ipinfo.token'] || env.SHARING_IPINFO_TOKEN?.trim();
            if (!token) return null;
            const credentials = createHash('sha256').update(token).digest('hex');
            const cached = cache.get(ip);
            if (cached?.credentials === credentials && cached.expires > now()) return cached.location;
            let location = null;
            try {
                const { data } = await http.get(`https://api.ipinfo.io/lite/${encodeURIComponent(ip)}`, {
                    headers: { Authorization: `Bearer ${token}` }, timeout: 4000,
                });
                if (!data.bogon && /^[A-Z]{2}$/.test(data.country_code) && typeof data.country === 'string' && data.country.trim())
                    location = { key: data.country_code, label: data.country.trim() };
            } catch { /* A failed lookup must not interrupt sharing. */ }
            if (cache.size >= 2000) cache.delete(cache.keys().next().value);
            cache.set(ip, { credentials, location, expires: now() + (location ? 86400000 : 300000) });
            return location;
        } catch { return null; }
    };
};

module.exports = { createRegionLocator };
