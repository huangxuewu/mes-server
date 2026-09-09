const db = require('../../models');
const { isIP } = require('node:net');
const { getActiveSessionUser, hasPermission } = require('../session');
const { getLatestRelease, getStationUpdate } = require('../../utils/stationRelease');
const { getStationScreenshots } = require('../../utils/stationScreenshots');
const { getStationRoster } = require('../../utils/stationRoster');

module.exports = (socket, io) => {
    const screenshots = getStationScreenshots(io);
    const roster = getStationRoster(io);
    socket.on('disconnect', () => {
        if (socket.data.stationConnection || socket.data.stationPresence) void roster.publish();
    });
    socket.on('stations:unsubscribe', () => {
        delete socket.data.stationsViewer;
        socket.data.stationsSubscription = (socket.data.stationsSubscription || 0) + 1;
    });
    for (const action of ['get', 'capture']) socket.on(`station:screenshot:${action}`, async (payload, callback) => {
        try {
            const user = await getActiveSessionUser(socket);
            if (!hasPermission(user, 'access', 'configuration.page.access')) throw new Error('Access denied');
            if (typeof payload?._id !== 'string' || !/^[a-f\d]{24}$/i.test(payload._id)) throw new Error('Invalid station');
            if (action === 'get') return callback({ status: 'success', payload: await screenshots.read(payload._id, socket) });
            await screenshots.capture(payload._id);
            const currentUser = await getActiveSessionUser(socket);
            if (!hasPermission(currentUser, 'access', 'configuration.page.access')) throw new Error('Access denied');
            callback({ status: 'success' });
        } catch (error) { callback?.({ status: 'error', message: error.message }); }
    });

    socket.on('station:heartbeat', async (payload, callback) => {
        try {
            if (typeof payload?.stationId !== 'string' || !payload?._id) throw new Error('Invalid station identity');
            const previousDeployment = socket.data.stationDeployment;
            const heartbeat = socket.data.stationHeartbeat = (socket.data.stationHeartbeat || 0) + 1;
            const source = payload.computer || {};
            const computer = {};
            for (const key of ['hostname', 'platform', 'release', 'arch', 'cpu', 'appVersion'])
                computer[key] = typeof source[key] === 'string' ? source[key].slice(0, 256) : '';
            for (const key of ['cpuCount', 'memoryBytes'])
                computer[key] = Number.isFinite(source[key]) && source[key] >= 0 ? source[key] : 0;
            computer.ipAddresses = [...new Set((Array.isArray(source.ipAddresses) ? source.ipAddresses : [])
                .filter(address => typeof address === 'string' && isIP(address) === 4))].slice(0, 20);
            computer.disks = Array.isArray(source.disks) ? source.disks.filter(disk => disk && typeof disk.name === 'string'
                && Number.isSafeInteger(disk.totalBytes) && disk.totalBytes >= 0
                && Number.isSafeInteger(disk.availableBytes) && disk.availableBytes >= 0 && disk.availableBytes <= disk.totalBytes)
                .slice(0, 32).map(disk => ({ name: disk.name.slice(0, 256), label: typeof disk.label === 'string' ? disk.label.slice(0, 256) : '',
                    totalBytes: disk.totalBytes, availableBytes: disk.availableBytes })) : null;
            computer.devices = {};
            for (const kind of ['cameras', 'speakers', 'microphones'])
                computer.devices[kind] = Array.isArray(source.devices?.[kind]) ? [...new Set(source.devices[kind]
                    .filter(name => typeof name === 'string' && name.trim()).map(name => name.trim().slice(0, 256)))].slice(0, 32) : null;
            computer.remoteAddress = String(socket.handshake.address || '').slice(0, 128);
            const lastSeenAt = new Date();
            const station = await db.station.findOneAndUpdate(
                { _id: payload._id, stationId: payload.stationId },
                { $set: { ...(payload.computer ? { computer } : {}), lastSeenAt, screenshotSupported: payload.screenshotSupported === true } },
                { new: true, runValidators: true }
            );
            if (!station) {
                delete socket.data.stationPresence;
                delete socket.data.stationConnection;
                void roster.publish();
                throw new Error('Station identity is no longer linked');
            }
            if (!socket.connected) return;
            socket.data.stationPresence = { _id: String(station._id), stationId: station.stationId, at: lastSeenAt.getTime() };
            socket.data.stationConnection = { _id: String(station._id), stationId: station.stationId };
            const screenshotBecameAvailable = payload.screenshotSupported === true && socket.data.screenshotSupported !== true;
            socket.data.screenshotSupported = payload.screenshotSupported === true;
            socket.data.liveSupported = payload.liveSupported === true;
            const deployment = payload.deployment;
            if (deployment !== undefined && socket.data.stationHeartbeat === heartbeat && socket.data.stationDeployment === previousDeployment) {
                socket.data.stationDeployment = ['idle', 'checking', 'downloading', 'installing', 'upToDate', 'failed'].includes(deployment?.status)
                    ? { status: deployment.status, version: typeof deployment.version === 'string' ? deployment.version.slice(0, 100) : '',
                        error: typeof deployment.error === 'string' ? deployment.error.slice(0, 500) : '',
                        ...(Number.isFinite(deployment.percent) ? { percent: Math.max(0, Math.min(100, Math.floor(deployment.percent))) } : {}),
                        ...(['github', 'server'].includes(deployment.source) ? { source: deployment.source } : {}) }
                    : null;
            }
            callback({ status: 'success', payload: station });
            void roster.publish();
            if (screenshotBecameAvailable) void screenshots.schedule().catch(error => console.error('[Station screenshots]', error.message));
        } catch (error) { callback({ status: 'error', message: error.message }); }
    });

    socket.on('stations:get', async (_payload, callback) => {
        const subscription = socket.data.stationsSubscription || 0;
        try {
            const user = await getActiveSessionUser(socket);
            if (!hasPermission(user, 'access', 'configuration.page.access')) throw new Error('Access denied');
            if (subscription !== (socket.data.stationsSubscription || 0)) throw new Error('Station subscription changed');
            socket.data.screenshotViewer = socket.data.sessionGeneration;
            socket.data.stationsViewer = socket.data.sessionGeneration;
            const generation = socket.data.sessionGeneration;
            const records = await roster.read();
            const currentUser = await getActiveSessionUser(socket);
            if (generation !== socket.data.sessionGeneration || !hasPermission(currentUser, 'access', 'configuration.page.access'))
                throw new Error('Access denied');
            callback({ status: 'success', payload: records });
        } catch (error) { callback({ status: 'error', message: error.message }); }
    });

    socket.on('station:deploy', async (payload, callback) => {
        try {
            const user = await getActiveSessionUser(socket);
            if (!hasPermission(user, 'access', 'configuration.page.access')) throw new Error('Access denied');
            if (typeof payload?._id !== 'string' || !/^[a-f\d]{24}$/i.test(payload._id)) throw new Error('Invalid station');
            const release = await getLatestRelease({ force: true });
            const currentUser = await getActiveSessionUser(socket);
            if (!hasPermission(currentUser, 'access', 'configuration.page.access')) throw new Error('Access denied');
            const station = await db.station.findById(payload._id).lean();
            if (!station?.stationId) throw new Error('Station is not linked');
            const update = getStationUpdate(station.computer?.appVersion, release);
            void roster.publish();
            if (update.remoteDeploySupported !== true) throw new Error('Remote deployment requires MES 26.3317.1990 or later');
            if (update.error) throw new Error('Unable to check the latest MES release. Try again later.');
            if (!update.available) throw new Error('Station is already up to date');
            if (payload.version && payload.version !== release.version) throw new Error('The latest release changed. Review the updated version and try again.');
            const target = [...io.sockets.sockets.values()]
                .filter(client => client.connected && client.data.stationPresence?._id === String(station._id)
                    && client.data.stationPresence.stationId === station.stationId)
                .sort((a, b) => b.data.stationPresence.at - a.data.stationPresence.at)[0];
            if (!target) throw new Error('Station is offline');
            if (!target.data.stationDeployment) throw new Error('Update this station once to enable remote deployment');
            if (target.data.deploying || ['checking', 'downloading', 'installing'].includes(target.data.stationDeployment.status))
                throw new Error('An update is already in progress');
            target.data.deploying = true;
            const previousDeployment = target.data.stationDeployment;
            try {
                const response = await new Promise((resolve, reject) => {
                    target.timeout(5000).emit('station:deploy', { _id: String(station._id), stationId: station.stationId, version: release.version }, (error, result) => {
                        if (error) return reject(new Error('Station did not acknowledge deployment. Refresh its status before retrying.'));
                        resolve(result);
                    });
                });
                if (!response?.success) throw new Error(response?.error || 'Station rejected deployment');
                if (target.data.stationDeployment === previousDeployment) target.data.stationDeployment = { status: 'checking' };
                callback({ status: 'success', payload: { _id: String(station._id), deployment: target.data.stationDeployment } });
                void roster.publish();
            } finally { target.data.deploying = false; }
        } catch (error) { callback({ status: 'error', message: error.message }); }
    });
};
