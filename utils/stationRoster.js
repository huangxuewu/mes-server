const services = new WeakMap();

const getStationRoster = io => {
    if (services.has(io)) return services.get(io);
    const db = require('../models');
    const { getActiveSessionUser, hasPermission } = require('../socket/session');
    const { getLatestRelease, getStationUpdate } = require('./stationRelease');
    const screenshots = require('./stationScreenshots').getStationScreenshots(io);
    let revision = 0;

    const read = async () => {
        const stations = await db.station.find({}).sort({ name: 1, _id: 1 }).lean();
        const release = await getLatestRelease();
        const connections = [...io.sockets.sockets.values()]
            .filter(client => client.connected)
            .sort((a, b) => (b.data.stationPresence?.at || 0) - (a.data.stationPresence?.at || 0));
        return stations.map(station => {
            const connection = connections.find(client => {
                const identity = client.data.stationConnection || client.data.stationPresence;
                return identity?._id === String(station._id) && (identity.stationId || null) === (station.stationId || null);
            });
            return { ...station, ...screenshots.project(station), liveSupported: connection?.data.liveSupported === true,
                online: !!connection, deployment: connection?.data.stationDeployment || null,
                update: getStationUpdate(station.computer?.appVersion, release) };
        });
    };
    const publish = async () => {
        const current = ++revision;
        const viewers = [...io.sockets.sockets.values()].filter(socket => socket.connected
            && Number.isInteger(socket.data.stationsViewer) && socket.data.stationsViewer === socket.data.sessionGeneration);
        if (!viewers.length) return;
        try {
            const records = await read();
            await Promise.allSettled(viewers.map(async socket => {
                const generation = socket.data.stationsViewer;
                const user = await getActiveSessionUser(socket);
                if (current !== revision || !socket.connected || generation !== socket.data.sessionGeneration
                    || generation !== socket.data.stationsViewer || !hasPermission(user, 'access', 'configuration.page.access')) return;
                socket.emit('stations:changed', records);
            }));
        } catch (error) { console.error('[Station roster]', error.message); }
    };
    const service = { read, publish };
    services.set(io, service);
    return service;
};

module.exports = { getStationRoster };
