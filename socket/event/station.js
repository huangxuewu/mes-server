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
            const deployment = payload.deployment;
            socket.data.stationDeployment = ['idle', 'checking', 'downloading', 'installing', 'upToDate', 'failed'].includes(deployment?.status)
                ? { status: deployment.status, version: typeof deployment.version === 'string' ? deployment.version.slice(0, 100) : '',
                    error: typeof deployment.error === 'string' ? deployment.error.slice(0, 500) : '' }
                : null;
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
                .sort((a, b) => b.data.stationPresence.at - a.data.stationPresence.at);
            callback({ status: 'success', payload: stations.map(station => {
                const connection = connections.find(client => client.data.stationPresence._id === String(station._id)
                    && client.data.stationPresence.stationId === station.stationId);
                return { ...station, online: !!connection, deployment: connection?.data.stationDeployment || null };
            }) });
        } catch (error) { callback({ status: 'error', message: error.message }); }
    });

    socket.on('station:deploy', async (payload, callback) => {
        try {
            const user = await getActiveSessionUser(socket);
            if (!hasPermission(user, 'access', 'configuration.page.access')) throw new Error('Access denied');
            if (typeof payload?._id !== 'string' || !/^[a-f\d]{24}$/i.test(payload._id)) throw new Error('Invalid station');
            const station = await db.station.findById(payload._id).lean();
            if (!station?.stationId) throw new Error('Station is not linked');
            const target = [...io.sockets.sockets.values()]
                .filter(client => client.connected && client.data.stationPresence?._id === String(station._id)
                    && client.data.stationPresence.stationId === station.stationId
                    && client.data.stationPresence.at > Date.now() - 90000)
                .sort((a, b) => b.data.stationPresence.at - a.data.stationPresence.at)[0];
            if (!target) throw new Error('Station is offline');
            if (!target.data.stationDeployment) throw new Error('Update this station once to enable remote deployment');
            if (target.data.deploying || ['checking', 'downloading', 'installing'].includes(target.data.stationDeployment.status))
                throw new Error('An update is already in progress');
            target.data.deploying = true;
            const previousDeployment = target.data.stationDeployment;
            try {
                const response = await new Promise((resolve, reject) => {
                    target.timeout(5000).emit('station:deploy', { _id: String(station._id), stationId: station.stationId }, (error, result) => {
                        if (error) return reject(new Error('Station did not acknowledge deployment. Refresh its status before retrying.'));
                        resolve(result);
                    });
                });
                if (!response?.success) throw new Error(response?.error || 'Station rejected deployment');
                if (target.data.stationDeployment === previousDeployment) target.data.stationDeployment = { status: 'checking' };
                callback({ status: 'success', payload: { _id: String(station._id), deployment: target.data.stationDeployment } });
            } finally { target.data.deploying = false; }
        } catch (error) { callback({ status: 'error', message: error.message }); }
    });
};
