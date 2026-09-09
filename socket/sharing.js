const { randomBytes } = require('node:crypto');
const { isIP } = require('node:net');
const axios = require('axios');
const { getActiveSessionUser, onSessionEnded } = require('./session');

const services = new WeakMap();
const locationCache = new Map();

const locate = async socket => {
    // The trusted Heroku router appends the actual client to the forwarded chain.
    const forwarded = process.env.DYNO ? socket.handshake.headers['x-forwarded-for']?.split(',').at(-1)?.trim() : null;
    const ip = String(forwarded || socket.handshake.address || '').replace(/^::ffff:/, '');
    if (!isIP(ip) || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|::1$|f[cd]|fe80:)/i.test(ip)) return null;
    const cached = locationCache.get(ip);
    if (cached?.expires > Date.now()) return cached.location;
    if (!process.env.SHARING_GEO_ACCOUNT_ID || !process.env.SHARING_GEO_LICENSE_KEY) return null;
    let location = null;
    try {
        const { data } = await axios.get(`https://geolite.info/geoip/v2.1/city/${encodeURIComponent(ip)}`, {
            auth: { username: process.env.SHARING_GEO_ACCOUNT_ID, password: process.env.SHARING_GEO_LICENSE_KEY }, timeout: 4000,
        });
        if (data.city?.geoname_id) location = { key: String(data.city.geoname_id),
            label: [data.city.names?.en, data.subdivisions?.[0]?.iso_code, data.country?.iso_code].filter(Boolean).join(', ') };
    } catch { /* Location is optional; sharing still works when lookup is unavailable. */ }
    if (locationCache.size >= 2000) locationCache.delete(locationCache.keys().next().value);
    locationCache.set(ip, { location, expires: Date.now() + (location ? 86400000 : 300000) });
    return location;
};

const createSharing = ({ io, authorize = getActiveSessionUser, locatePeer = locate, now = Date.now }) => {
    const peers = new Map();
    let published = '';
    const active = peer => peer && peer.socket.connected && peer.generation === peer.socket.data.sessionGeneration
        && peer.socket.data.expiresAt > now() && now() - peer.seen < 45000;
    const snapshot = () => {
        const current = [...peers.values()].filter(active);
        const groups = new Map(current.map(peer => [peer.socket.id, peer.socket.id]));
        for (const peer of current) for (const other of current) {
            if (now() - (peer.observedAt || 0) > 20000 || now() - (other.observedAt || 0) > 20000) continue;
            if (!peer.nearby.has(other.socket.id) || !other.nearby.has(peer.socket.id)) continue;
            const from = groups.get(other.socket.id), to = groups.get(peer.socket.id);
            if (from === to) continue;
            for (const [id, group] of groups) if (group === from) groups.set(id, to);
        }
        return current.map(peer => ({ id: peer.socket.id, userId: String(peer.user._id),
            name: peer.user.displayName || peer.user.username, portrait: peer.user.portrait || '',
            device: peer.device, deviceId: peer.deviceId, region: peer.region, network: groups.get(peer.socket.id) }));
    };
    const publish = () => {
        const payload = snapshot();
        const signature = JSON.stringify(payload);
        if (signature === published) return;
        published = signature;
        for (const peer of peers.values()) if (active(peer)) peer.socket.emit('sharing:peers', payload);
    };
    const remove = id => { if (peers.delete(id)) publish(); };
    const register = async (socket, input = {}) => {
        const generation = socket.data.sessionGeneration;
        const user = await authorize(socket);
        const previous = peers.get(socket.id);
        const region = previous?.generation === generation ? previous.region : await locatePeer(socket);
        if (!socket.connected || generation !== socket.data.sessionGeneration || socket.data.expiresAt <= now()) throw new Error('Session changed');
        const peer = previous?.generation === generation ? previous : { socket, generation, nearby: new Set(), token: '', issued: 0 };
        if (now() - peer.issued > 60000 || !peer.token) {
            peer.previousToken = peer.token;
            peer.token = randomBytes(24).toString('hex');
            peer.issued = now();
        }
        Object.assign(peer, { user, region, seen: now(), device: String(input.device || '').slice(0, 100), deviceId: String(input.deviceId || socket.id).slice(0, 128) });
        peers.set(socket.id, peer);
        publish();
        const urls = (process.env.SHARING_STUN_URLS || 'stun:stun.l.google.com:19302').split(',').map(value => value.trim()).filter(value => /^stuns?:[^\s]+$/.test(value));
        return { id: socket.id, token: peer.token, peers: snapshot(), iceServers: urls.length ? [{ urls }] : [] };
    };
    const observe = (socket, input = {}) => {
        const peer = peers.get(socket.id);
        if (!active(peer)) throw new Error('Sharing session unavailable');
        if (!Array.isArray(input.tokens) || input.tokens.length > 500 || input.tokens.some(token => !/^[a-f0-9]{48}$/.test(token))) throw new Error('Invalid discovery');
        peer.nearby = new Set([...peers.values()].filter(other => active(other) && other !== peer
            && (input.tokens.includes(other.token) || (now() - other.issued < 20000 && input.tokens.includes(other.previousToken)))).map(other => other.socket.id));
        peer.observedAt = now();
        publish();
    };
    const signal = (socket, input = {}) => {
        const source = peers.get(socket.id), target = peers.get(input.to);
        if (!active(source) || !active(target) || source === target) throw new Error('Peer unavailable');
        if (!['request', 'offer', 'answer', 'candidate', 'close'].includes(input.type) || JSON.stringify(input).length > 65536) throw new Error('Invalid signal');
        if (now() - (source.signalAt || 0) > 10000) { source.signalAt = now(); source.signals = 0; }
        source.signals = (source.signals || 0) + 1;
        if (source.signals > 300) throw new Error('Too many signals');
        target.socket.emit('sharing:signal', { from: socket.id, type: input.type, data: input.data });
    };
    const sweep = () => { let changed = false; for (const [id, peer] of peers) if (!active(peer)) { peers.delete(id); changed = true; } if (changed) publish(); };
    return { register, observe, signal, remove, sweep, snapshot };
};

const getSharing = io => {
    if (!services.has(io)) {
        const service = createSharing({ io });
        onSessionEnded(service.remove);
        setInterval(service.sweep, 10000).unref();
        services.set(io, service);
    }
    return services.get(io);
};
module.exports = { createSharing, getSharing };
