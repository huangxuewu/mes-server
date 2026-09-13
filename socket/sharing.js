const { randomBytes } = require('node:crypto');
const { createRegionLocator } = require('../utils/sharingLocation');
const { getActiveSessionUser, onSessionEnded } = require('./session');
const { createPhoneSharing, attachPhoneSharing } = require('./phoneSharing');

const { getIceServers } = require('../utils/runtimeConfig');
const services = new WeakMap();
const locate = createRegionLocator();

const createSharing = ({ io, authorize = getActiveSessionUser, locatePeer = locate, now = Date.now, db }) => {
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
    const snapshotFor = socket => [...snapshot(), ...[phone.peer(socket)].filter(Boolean)];
    const publishTo = socket => { if (active(peers.get(socket.id))) socket.emit('sharing:peers', snapshotFor(socket)); };
    const phone = createPhoneSharing({ getOwner: id => peers.get(id), active, publish: publishTo, now, db });
    const publish = () => {
        const payload = snapshot();
        const signature = JSON.stringify(payload);
        if (signature === published) return;
        published = signature;
        for (const peer of peers.values()) if (active(peer)) publishTo(peer.socket);
    };
    const remove = id => { phone.remove(id); if (peers.delete(id)) publish(); };
    const register = async (socket, input = {}) => {
        const generation = socket.data.sessionGeneration;
        const user = await authorize(socket);
        const previous = peers.get(socket.id);
        const [region, iceServers] = await Promise.all([locatePeer(socket), getIceServers({ db })]);
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
        return { id: socket.id, token: peer.token, peers: snapshotFor(socket), iceServers };
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
        if (typeof input.to === 'string' && input.to.startsWith('phone:')) return phone.signalDesktop(socket, input);
        const source = peers.get(socket.id), target = peers.get(input.to);
        if (!active(source) || !active(target) || source === target) throw new Error('Peer unavailable');
        if (!['request', 'offer', 'answer', 'candidate', 'close'].includes(input.type) || JSON.stringify(input).length > 65536) throw new Error('Invalid signal');
        if (now() - (source.signalAt || 0) > 10000) { source.signalAt = now(); source.signals = 0; }
        source.signals = (source.signals || 0) + 1;
        if (source.signals > 300) throw new Error('Too many signals');
        target.socket.emit('sharing:signal', { from: socket.id, type: input.type, data: input.data });
    };
    const sweep = () => { phone.sweep(); let changed = false; for (const [id, peer] of peers) if (!active(peer)) { peers.delete(id); changed = true; } if (changed) publish(); };
    return { register, observe, signal, remove, sweep, snapshot, phone };
};

const getSharing = io => {
    if (!services.has(io)) {
        const service = createSharing({ io });
        attachPhoneSharing(io, service.phone);
        onSessionEnded(service.remove);
        setInterval(service.sweep, 10000).unref();
        services.set(io, service);
    }
    return services.get(io);
};
module.exports = { createSharing, getSharing };
