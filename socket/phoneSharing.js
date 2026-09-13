const { randomBytes, randomUUID, timingSafeEqual } = require('node:crypto');

const { getIceServers } = require('../utils/runtimeConfig');

const IDLE_MS = 10 * 60 * 1000;
const MAX_MS = 24 * 60 * 60 * 1000;
const normalizePhoneSharingUrl = value => {
    if (typeof value !== 'string') throw new Error('phoneConfiguration');
    const trimmed = value.trim();
    if (!trimmed) return '';
    try {
        const url = new URL(trimmed);
        if (trimmed.length > 2048 || /\s/.test(trimmed) || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
            || trimmed.includes('?') || trimmed.includes('#') || url.pathname.replace(/\/$/, '') !== '/sharing') throw new Error();
    } catch { throw new Error('phoneConfiguration'); }
    return trimmed;
};
const secretMatches = (left, right) => typeof right === 'string' && /^[a-f0-9]{64}$/.test(right) && left.length === right.length
    && timingSafeEqual(Buffer.from(left), Buffer.from(right));

const createPhoneSharing = ({ getOwner, active, publish, now = Date.now,
    db,
    renderQr = url => require('qrcode').toDataURL(url, { width: 320, margin: 4, errorCorrectionLevel: 'M' }) }) => {
    const sessions = new Map();
    const byOwner = new Map();
    const state = session => ({ id: session.id, status: session.status, peerId: session.peerId,
        createdAt: session.createdAt, expiresAt: session.expiresAt, idleExpiresAt: session.idleExpiresAt });
    const notify = session => {
        session.owner.socket.emit('sharing:phone', state(session));
        session.socket?.emit('phone:state', state(session));
    };
    const end = (session, status = 'cancelled') => {
        if (!sessions.has(session.id)) return;
        sessions.delete(session.id); byOwner.delete(session.owner.socket.id);
        session.status = status;
        notify(session);
        session.socket?.disconnect(true);
        publish(session.owner.socket);
    };
    const valid = session => {
        if (!session || !sessions.has(session.id)) return false;
        if (!active(session.owner) || getOwner(session.owner.socket.id) !== session.owner) { end(session, 'cancelled'); return false; }
        if (now() >= Math.min(session.expiresAt, session.idleExpiresAt)) { end(session, 'expired'); return false; }
        return true;
    };
    const requireSession = id => {
        const session = sessions.get(id);
        if (!valid(session)) throw new Error('phoneExpired');
        return session;
    };
    const touch = session => {
        session.idleExpiresAt = Math.min(session.expiresAt, now() + IDLE_MS);
        notify(session);
    };
    const create = async (socket, input = {}) => {
        const owner = getOwner(socket.id);
        if (!active(owner)) throw new Error('phoneUnavailable');
        let configuration, iceServers;
        try {
            iceServers = await getIceServers({ db });
            const at = new Date(now());
            configuration = await (db || require('../models')).config.findOne({
                key: 'integration.sharing.publicUrl', scope: 'Global', status: 'Active',
                'effective.from': { $lte: at }, $or: [{ 'effective.to': null }, { 'effective.to': { $gte: at } }],
            }, { value: 1 }).maxTimeMS(1500).lean();
        } catch { throw new Error('phoneUnavailable'); }
        if (!active(owner) || getOwner(socket.id) !== owner) throw new Error('phoneUnavailable');
        // Check again after the database read so concurrent requests reuse one invitation.
        const previous = sessions.get(byOwner.get(socket.id));
        if (valid(previous)) {
            await previous.rendering;
            if (!valid(previous)) throw new Error('phoneExpired');
            return { ...state(previous), qr: previous.qr, url: previous.url };
        }
        let url;
        try {
            url = new URL(normalizePhoneSharingUrl(configuration?.value));
        } catch { throw new Error('phoneConfiguration'); }
        const token = randomBytes(32).toString('hex');
        url.hash = token;
        const createdAt = now();
        const session = { id: randomUUID(), iceServers, owner, token, key: '', peerId: `phone:${randomUUID()}`, status: 'waiting',
            language: ['en', 'cn', 'es', 'ja'].includes(input.language) ? input.language : 'en',
            createdAt, expiresAt: createdAt + MAX_MS, idleExpiresAt: createdAt + IDLE_MS, url: url.href };
        sessions.set(session.id, session); byOwner.set(socket.id, session.id);
        session.rendering = Promise.resolve().then(() => renderQr(session.url));
        try { session.qr = await session.rendering; }
        catch { end(session); throw new Error('phoneUnavailable'); }
        if (!sessions.has(session.id) || !valid(session)) throw new Error('phoneExpired');
        return { ...state(session), qr: session.qr, url: session.url };
    };
    const cancel = (socket, input = {}) => {
        const session = sessions.get(input.id);
        if (!session) return;
        if (session.owner.socket !== socket || session.owner !== getOwner(socket.id) || !active(session.owner)) throw new Error('phoneUnauthorized');
        end(session);
    };
    const claim = (socket, input = {}) => {
        if (typeof input.key !== 'string' || !/^[a-f0-9]{64}$/.test(input.key)) throw new Error('phoneExpired');
        const session = input.id ? requireSession(input.id)
            : [...sessions.values()].find(session => typeof input.invite === 'string' && secretMatches(session.token, input.invite));
        if (!valid(session) || (session.key && !secretMatches(session.key, input.key))) throw new Error('phoneExpired');
        if (input.id && !session.key) throw new Error('phoneExpired');
        if (session.socket?.connected && session.socket !== socket) throw new Error('phoneInUse');
        const first = !session.key;
        session.key = input.key; session.socket = socket; session.status = 'connected';
        socket.data.phoneSessionId = session.id;
        if (first) session.idleExpiresAt = Math.min(session.expiresAt, now() + IDLE_MS);
        return session;
    };
    const connected = socket => {
        const session = requireSession(socket.data.phoneSessionId);
        notify(session); publish(session.owner.socket);
        socket.emit('phone:ready', { ...state(session), desktopId: session.owner.socket.id,
            desktopName: session.owner.device, language: session.language, iceServers: session.iceServers });
    };
    const disconnected = socket => {
        const session = sessions.get(socket.data.phoneSessionId);
        if (!session || session.socket !== socket) return;
        session.socket = null; session.status = 'reconnecting';
        notify(session); publish(session.owner.socket);
    };
    const peer = socket => {
        const session = sessions.get(byOwner.get(socket.id));
        if (!session || !session.socket?.connected || !sessions.has(session.id)) return null;
        return { id: session.peerId, userId: session.peerId, deviceId: session.id, name: session.owner.user.displayName || session.owner.user.username,
            device: 'Phone', phone: true, region: session.owner.region, network: session.owner.socket.id };
    };
    const validateSignal = (session, input, side) => {
        if (!['request', 'offer', 'answer', 'candidate', 'close'].includes(input?.type) || JSON.stringify(input).length > 65536) throw new Error('Invalid signal');
        const key = `${side}Rate`;
        if (!session[key] || now() - session[key].at >= 10000) session[key] = { at: now(), count: 0 };
        if (++session[key].count > 300) throw new Error('Too many signals');
    };
    const signalDesktop = (socket, input) => {
        const session = requireSession(byOwner.get(socket.id));
        if (input.to !== session.peerId || !session.socket?.connected) throw new Error('phoneUnavailable');
        validateSignal(session, input, 'desktop');
        session.socket.emit('phone:signal', { from: socket.id, type: input.type, data: input.data });
    };
    const signalPhone = (socket, input) => {
        const session = requireSession(socket.data.phoneSessionId);
        if (session.socket !== socket || input.to !== session.owner.socket.id) throw new Error('phoneUnauthorized');
        validateSignal(session, input, 'phone');
        session.owner.socket.emit('sharing:signal', { from: session.peerId, type: input.type, data: input.data });
    };
    const activity = socket => {
        const session = requireSession(socket.data.phoneSessionId);
        if (session.socket !== socket) throw new Error('phoneUnauthorized');
        if (now() - (session.activityAt || 0) < 1000) return;
        session.activityAt = now(); touch(session);
    };
    const progress = (socket, input = {}) => {
        const session = requireSession(input.id);
        if (session.owner.socket !== socket) throw new Error('phoneUnauthorized');
        if (now() - (session.progressAt || 0) < 1000) return;
        session.progressAt = now(); touch(session);
    };
    const leave = (input = {}) => {
        const session = sessions.get(input?.id);
        if (session?.key && secretMatches(session.key, input.key)) end(session);
    };
    const remove = id => { const session = sessions.get(byOwner.get(id)); if (session) end(session); };
    const sweep = () => { for (const session of sessions.values()) valid(session); };
    return { create, cancel, claim, connected, disconnected, peer, signalDesktop, signalPhone, activity, progress, leave, remove, sweep };
};

const attachPhoneSharing = (io, service) => {
    const namespace = io.of('/sharing-phone');
    namespace.use((socket, next) => {
        try { service.claim(socket, socket.handshake.auth); next(); }
        catch (error) { next(error); }
    });
    namespace.on('connection', socket => {
        for (const [event, action] of Object.entries({ signal: service.signalPhone, activity: service.activity })) socket.on(`phone:${event}`, (input, callback) => {
            try { action(socket, input); if (typeof callback === 'function') callback({ status: 'success' }); }
            catch (error) { if (typeof callback === 'function') callback({ status: 'error', message: error.message }); }
        });
        socket.on('disconnect', () => service.disconnected(socket));
        try { service.connected(socket); } catch { socket.disconnect(true); }
    });
};

module.exports = { createPhoneSharing, attachPhoneSharing, normalizePhoneSharingUrl, IDLE_MS, MAX_MS };
