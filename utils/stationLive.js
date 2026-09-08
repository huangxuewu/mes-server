const { randomUUID, createHash } = require('node:crypto');
const services = new WeakMap();
const STATION_FIELDS = '_id stationId screenshotsEnabled status screenshotGeneration';

const createStationLive = ({ io, db, authorize, validateImage, now = Date.now }) => {
    const sessions = new Map();
    const isSelf = (viewer, station, target) => viewer === target || viewer.id === target?.id
        || [viewer.data.stationConnection, viewer.data.stationPresence].some(binding => binding
            && (String(binding._id) === String(station._id) || (binding.stationId && binding.stationId === station.stationId)));
    const targetFor = station => {
        let target;
        for (const socket of io.sockets.sockets.values()) {
            const presence = socket.data.stationPresence;
            if (socket.connected && presence?._id === String(station._id) && presence.stationId === station.stationId
                && (!target || presence.at > target.data.stationPresence.at)) target = socket;
        }
        return target;
    };
    const command = (session, type, data = {}) => new Promise((resolve, reject) => {
        session.target.timeout(6000).emit('station:live:command', { ...data, type, sessionId: session.id,
            _id: session.stationId, stationId: session.identity, generation: session.generation }, (error, response) => {
            if (error || !response?.success) return reject(new Error(response?.error || 'connectionLost'));
            resolve(response);
        });
    });
    const end = (session, reason = 'ended') => {
        if (!session || !sessions.delete(session.id)) return;
        session.viewer.emit('station:live:ended', { sessionId: session.id, reason });
        session.target.emit('station:live:ended', { sessionId: session.id, reason });
    };
    const valid = async session => {
        if (!sessions.has(session.id)) throw new Error('ended');
        try {
            if (!session.viewer.connected || !session.target.connected
                || session.viewer.data.sessionGeneration !== session.viewerGeneration) throw new Error('connectionLost');
            await authorize(session.viewer);
            const station = await db.station.findById(session.stationId, STATION_FIELDS).lean();
            if (!station || station.screenshotsEnabled === false || station.status === 'Disabled'
                || station.stationId !== session.identity || (station.screenshotGeneration || 0) !== session.generation)
                throw new Error('privacyChanged');
            if (targetFor(station) !== session.target) throw new Error('connectionLost');
            if (isSelf(session.viewer, station, session.target)) throw new Error('selfView');
            if (!sessions.has(session.id)) throw new Error('ended');
            session.validatedAt = now();
            return station;
        } catch (error) { end(session, error.message); throw error; }
    };
    const owned = (socket, id) => {
        const session = sessions.get(id);
        if (!session || session.viewer !== socket) throw new Error('ended');
        return session;
    };
    const start = async (viewer, id, options = {}) => {
        const viewerGeneration = viewer.data.sessionGeneration;
        const operator = await authorize(viewer);
        const station = await db.station.findById(id, STATION_FIELDS).lean();
        if (!station?.stationId || station.screenshotsEnabled === false || station.status === 'Disabled') throw new Error('privacyChanged');
        const target = targetFor(station);
        if (isSelf(viewer, station, target)) throw new Error('selfView');
        if (!target) throw new Error('offline');
        if (!target.data.liveSupported) throw new Error('updateRequired');
        if ([...sessions.values()].some(session => session.stationId === String(id) || session.viewer === viewer)) throw new Error('busy');
        const session = { id: randomUUID(), stationId: String(id), identity: station.stationId,
            generation: station.screenshotGeneration || 0, viewer, viewerGeneration, target,
            touched: now(), busy: false, frameAt: -Infinity, nextFrameAt: -Infinity, optimized: options.frameProtocol === 2,
            idleFrames: 0, commands: [], points: 0, chat: false, messages: 0 };
        sessions.set(session.id, session);
        try {
            await valid(session);
            const response = await command(session, 'start', { operator: String(operator?.displayName || operator?.username || '').slice(0, 100) });
            session.nativeOptimized = response.frameProtocol === 2;
            await valid(session);
            return { sessionId: session.id, frameProtocol: 2 };
        } catch (error) { end(session, error.message); throw error; }
    };
    const frame = async (viewer, id) => {
        const session = owned(viewer, id);
        if (session.busy || now() - session.frameAt < 200 || now() < session.nextFrameAt) throw new Error('busy');
        session.busy = true;
        session.frameAt = now();
        session.touched = now();
        try {
            await valid(session);
            const response = await command(session, 'frame', session.optimized && session.nativeOptimized
                ? { frameProtocol: 2, previousRevision: session.revision } : {});
            const contents = Buffer.isBuffer(response.contents) ? response.contents
                : response.contents instanceof Uint8Array ? Buffer.from(response.contents) : null;
            let revision, dimensions, unchanged;
            if (response.unchanged === true) {
                if (!session.optimized || !session.nativeOptimized || !session.revision || response.revision !== session.revision
                    || response.contents !== undefined) throw new Error('invalidFrame');
                revision = session.revision; dimensions = session.dimensions; unchanged = true;
            } else {
                if (!contents?.length || contents.length > 5 * 1024 * 1024) throw new Error('invalidFrame');
                revision = createHash('sha256').update(contents).digest('hex');
                unchanged = session.optimized && revision === session.revision;
                dimensions = unchanged ? session.dimensions : await validateImage(contents);
            }
            await valid(session);
            session.revision = revision; session.dimensions = dimensions;
            session.idleFrames = unchanged ? session.idleFrames + 1 : 0;
            // Bound idle capture work and pace large images to a 512 KiB/s payload target per leg.
            const nextPollMs = Math.max(Math.min(2000, 500 * 2 ** Math.min(session.idleFrames, 2)),
                Math.ceil((contents?.length || 0) / (512 * 1024) * 1000));
            session.nextFrameAt = session.optimized ? now() + nextPollMs : -Infinity;
            return { sessionId: session.id, ...(unchanged ? { unchanged: true } : { contents }), ...dimensions,
                revision, nextPollMs, mime: 'image/jpeg' };
        } catch (error) { end(session, error.message); throw error; }
        finally { session.busy = false; }
    };
    const rateLimit = session => {
        session.commands = session.commands.filter(at => now() - at < 1000);
        if (session.commands.length >= 25) throw new Error('tooFast');
        session.commands.push(now());
    };
    const action = async (viewer, input) => {
        const session = owned(viewer, input.sessionId);
        if (session.actionBusy) throw new Error('busy');
        session.actionBusy = true;
        try {
            rateLimit(session);
            await valid(session);
            const data = {};
            if (input.type === 'pointer' || input.type === 'draw') {
                if (!Array.isArray(input.points) || input.points.length < 1 || input.points.length > 128
                    || input.points.some(point => !Array.isArray(point) || point.length !== 2
                        || point.some(value => !Number.isFinite(value) || value < 0 || value > 1))) throw new Error('invalidAction');
                data.points = input.type === 'pointer' ? input.points.slice(0, 1) : input.points;
                if (input.type === 'draw' && session.points + data.points.length > 20000) throw new Error('drawingLimit');
                if (input.type === 'draw') session.points += data.points.length;
            } else if (input.type === 'chat') {
                if (typeof input.enabled !== 'boolean') throw new Error('invalidAction');
                session.chat = input.enabled;
                data.enabled = input.enabled;
            } else if (input.type === 'message') {
                if (!session.chat) throw new Error('chatEnded');
                if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 2000 || session.messages >= 200)
                    throw new Error('invalidMessage');
                session.messages++;
                data.text = input.text.trim();
            } else if (input.type === 'clear') session.points = 0;
            else throw new Error('invalidAction');
            await command(session, input.type, data);
            await valid(session);
            return {};
        } finally { session.actionBusy = false; }
    };
    const remoteMessage = async (target, input) => {
        const session = sessions.get(input.sessionId);
        if (!session || session.target !== target) throw new Error('ended');
        rateLimit(session);
        await valid(session);
        if (!session.chat) throw new Error('chatEnded');
        if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 2000 || session.messages >= 200)
            throw new Error('invalidMessage');
        session.messages++;
        session.viewer.emit('station:live:message', { sessionId: session.id, text: input.text.trim() });
        return {};
    };
    const stop = (viewer, id) => { end(owned(viewer, id)); return {}; };
    const stopForSocket = socketId => {
        for (const session of sessions.values())
            if (session.viewer.id === socketId || session.target.id === socketId) end(session, 'connectionLost');
    };
    const changed = async id => {
        await Promise.allSettled([...sessions.values()].filter(session => session.stationId === String(id)).map(valid));
    };
    const sweep = async () => {
        await Promise.allSettled([...sessions.values()].map(session => now() - session.touched > 30000
            ? end(session, 'connectionLost') : now() - session.validatedAt >= 1000 ? valid(session) : undefined));
    };
    return { start, frame, action, remoteMessage, stop, stopForSocket, changed, sweep, sessions };
};

const getStationLive = io => {
    if (services.has(io)) return services.get(io);
    const { getActiveSessionUser, hasPermission, onSessionEnded, onPermissionsChanged } = require('../socket/session');
    const service = createStationLive({ io, db: require('../models'), validateImage: require('./stationScreenshots').validateImage,
        authorize: async socket => {
            const user = await getActiveSessionUser(socket);
            if (!hasPermission(user, 'access', 'configuration.page.access')) throw new Error('accessDenied');
            return user;
        } });
    onSessionEnded?.(service.stopForSocket);
    onPermissionsChanged?.(service.stopForSocket);
    let sweeping = false;
    const timer = setInterval(async () => {
        if (sweeping) return;
        sweeping = true;
        try { await service.sweep(); }
        finally { sweeping = false; }
    }, 1000);
    timer.unref?.();
    services.set(io, service);
    return service;
};

const isStationLive = (io, id) => [...(services.get(io)?.sessions.values() || [])].some(session => session.stationId === String(id));
module.exports = { getStationLive, createStationLive, isStationLive };
