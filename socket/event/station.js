const db = require('../../models');
const { isIP } = require('node:net');
const { getActiveSessionUser, hasPermission } = require('../session');

module.exports = (socket, io) => {
    socket.on('station:heartbeat', async (payload, callback) => {
        try {
            if (typeof payload?.stationId !== 'string' || !payload?._id) throw new Error('Invalid station identity');
            const source = payload.computer || {};
            const computer = {};
            for (const key of ['hostname', 'platform', 'release', 'arch', 'cpu', 'appVersion'])
                computer[key] = typeof source[key] === 'string' ? source[key].slice(0, 256) : '';
            for (const key of ['cpuCount', 'memoryBytes'])
                computer[key] = Number.isFinite(source[key]) && source[key] >= 0 ? source[key] : 0;
            computer.ipAddresses = [...new Set((Array.isArray(source.ipAddresses) ? source.ipAddresses : [])
                .filter(address => typeof address === 'string' && isIP(address)))].slice(0, 20);
            computer.remoteAddress = String(socket.handshake.address || '').slice(0, 128);
            const lastSeenAt = new Date();
            const station = await db.station.findOneAndUpdate(
                { _id: payload._id, stationId: payload.stationId },
                { $set: { computer, lastSeenAt } },
                { new: true, runValidators: true }
            );
            if (!station) {
                delete socket.data.stationPresence;
                throw new Error('Station identity is no longer linked');
            }
            if (!socket.connected) return;
            socket.data.stationPresence = { _id: String(station._id), stationId: station.stationId, at: lastSeenAt.getTime() };
            callback({ status: 'success', payload: station });
        } catch (error) { callback({ status: 'error', message: error.message }); }
    });

    socket.on('stations:get', async (_payload, callback) => {
        try {
            const user = await getActiveSessionUser(socket);
            if (!hasPermission(user, 'access', 'configuration.page.access')) throw new Error('Access denied');
            const stations = await db.station.find({}).sort({ name: 1, _id: 1 }).lean();
            const now = Date.now();
            const connections = [...io.sockets.sockets.values()]
                .filter(client => client.connected && client.data.stationPresence?.at > now - 90000)
                .map(client => client.data.stationPresence);
            callback({ status: 'success', payload: stations.map(station => ({
                ...station,
                online: connections.some(connection => connection._id === String(station._id)
                    && connection.stationId === station.stationId),
            })) });
        } catch (error) { callback({ status: 'error', message: error.message }); }
    });
};
