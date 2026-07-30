const db = require("../../models");
const mongoose = require("mongoose");

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAC_PATTERN = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/;
const SUPPORTED_APPLICATIONS = ['SOFTWARE', 'SIGNAGE', 'TIMECARD', 'VISITOR', 'LOADBOARD', 'PORTAL'];
const MAX_MAC_ADDRESSES = 20;
const MAX_RECOVERY_STATIONS = 50;
const STATION_CONFLICT_FIELDS = '_id name location application macAddress';

const normalizeUuid = value => String(value ?? '').trim().toLowerCase();
const normalizeMac = value => {
    const raw = String(value ?? '').trim().toLowerCase();
    const hex = raw.replace(/[^0-9a-f]/g, '');
    return hex.length === 12 ? hex.match(/.{2}/g).join(':') : raw;
};
const getMacAddresses = values => [...new Set((Array.isArray(values) ? values : [])
    .slice(0, MAX_MAC_ADDRESSES)
    .map(normalizeMac)
    .filter(value => MAC_PATTERN.test(value)))];
const getMacRegex = macAddress => new RegExp(`^${macAddress.split(':').join('[^0-9a-f]*')}$`, 'i');
const getLegacyStations = macAddresses => {
    if (!macAddresses.length) return [];
    return db.station.find({ macAddress: { $in: macAddresses.map(getMacRegex) } })
        .select(`${STATION_CONFLICT_FIELDS} stationId`)
        .limit(MAX_MAC_ADDRESSES + 1);
};
const conflictStations = stations => stations.slice(0, MAX_MAC_ADDRESSES).map(station => ({
    _id: station._id,
    name: station.name,
    location: station.location,
    application: station.application,
    macAddress: station.macAddress,
}));
const conflict = (reason, stations = []) => ({
    outcome: 'conflict',
    reason,
    stations: conflictStations(stations),
});
const resolved = (station, migrated = false) => ({ outcome: 'resolved', station, migrated });
const getRecoveryStations = () => db.station
    .find({})
    .select(STATION_CONFLICT_FIELDS)
    .sort({ name: 1 })
    .limit(MAX_RECOVERY_STATIONS)
    .lean();
const unconfigured = async () => ({
    outcome: 'unconfigured',
    stations: conflictStations(await getRecoveryStations()),
});
const validateStationId = value => {
    const stationId = normalizeUuid(value);
    if (!UUID_PATTERN.test(stationId)) throw new Error('Invalid stationId');
    return stationId;
};
const normalizeStation = value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid station');

    const station = {
        name: String(value.name ?? '').trim(),
        description: String(value.description ?? '').trim(),
        location: String(value.location ?? '').trim(),
        macAddress: normalizeMac(value.macAddress) || null,
        application: String(value.application ?? '').trim().toUpperCase(),
        status: value.status,
        allowedModules: value.allowedModules,
        config: value.config,
    };

    if (!station.name || !station.location || !station.application)
        throw new Error('Station name, location, and application are required');
    if (!SUPPORTED_APPLICATIONS.includes(station.application))
        throw new Error('Unsupported station application');
    return Object.fromEntries(Object.entries(station).filter(([, field]) => field !== undefined));
};

module.exports = (socket, io) => {


    socket.on("config:create", async (data, callback) => {
        try {
            const config = await db.config.create(data);
            callback({ status: "success", message: "Config created successfully", payload: config });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on("config:update", async (data, callback) => {
        try {
            console.log(data);
            const { key, ...update } = data;
            const config = await db.config.findOneAndUpdate({ key }, { $set: update }, { new: true });
            callback({ status: "success", message: "Config updated successfully", payload: config });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on("config:delete", async (data, callback) => {
        try {
            const config = await db.config.findByIdAndDelete(data._id);
            callback({ status: "success", message: "Config deleted successfully" });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on("config:get", async (data, callback) => {
        try {
            const config = await db.config.findOne(data);
            callback({ status: "success", message: "Config fetched successfully", payload: config });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on("config:fetch", async (query, callback) => {
        try {
            const config = await db.config.find(query);
            callback({ status: "success", message: "Config fetched successfully", payload: config });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on("station:get", async (query, callback) => {
        try {
            const macAddress = normalizeMac(query?.macAddress);
            const station = MAC_PATTERN.test(macAddress)
                ? await db.station.findOne({ macAddress: getMacRegex(macAddress) })
                : null;
            callback({ status: "success", message: "Station fetched successfully", payload: station });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on("station:create", async (data, callback) => {
        try {
            const { stationId, lastSeenAt, ...legacyStation } = data;
            const station = await db.station.create(legacyStation);
            callback({ status: "success", message: "Station created successfully", payload: station });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on("station:update", async (payload, callback) => {
        try {
            const { _id, stationId, lastSeenAt, ...data } = payload;
            const station = await db.station.findByIdAndUpdate(_id, { $set: data }, { new: true, runValidators: true });
            callback({ status: "success", message: "Station updated successfully", payload: station });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on("station:resolve", async (payload, callback) => {
        try {
            const stationId = validateStationId(payload?.stationId);
            const station = await db.station.findOneAndUpdate(
                { stationId },
                { $set: { lastSeenAt: new Date() } },
                { new: true }
            );
            if (station)
                return callback({ status: "success", message: "Station resolved successfully", payload: resolved(station) });

            if (payload?.allowLegacyMigration === false)
                return callback({ status: "success", message: "Station is not configured", payload: await unconfigured() });

            const stations = await getLegacyStations(getMacAddresses(payload?.macAddresses));
            if (!stations.length)
                return callback({ status: "success", message: "Station is not configured", payload: await unconfigured() });

            const owned = stations.filter(item => item.stationId);
            if (owned.length)
                return callback({ status: "success", message: "Station identity conflict", payload: conflict('owned', stations) });

            if (stations.length !== 1)
                return callback({ status: "success", message: "Station identity conflict", payload: conflict('multiple-matches', stations) });

            const bound = await db.station.findOneAndUpdate(
                { _id: stations[0]._id, stationId: { $exists: false } },
                { $set: { stationId, lastSeenAt: new Date() } },
                { new: true, runValidators: true }
            );
            if (bound)
                return callback({ status: "success", message: "Station resolved successfully", payload: resolved(bound, true) });

            const current = await getLegacyStations(getMacAddresses(payload?.macAddresses));
            return callback({ status: "success", message: "Station identity conflict", payload: conflict('race', current) });
        } catch (error) {
            if (error?.code === 11000) {
                const stations = await getLegacyStations(getMacAddresses(payload?.macAddresses));
                return callback({ status: "success", message: "Station identity conflict", payload: conflict('ownership-race', stations) });
            }
            callback({ status: "error", message: error.message });
        }
    });

    socket.on("station:enroll", async (payload, callback) => {
        try {
            const stationId = validateStationId(payload?.stationId);
            const existing = await db.station.findOneAndUpdate(
                { stationId },
                { $set: { lastSeenAt: new Date() } },
                { new: true }
            );
            if (existing)
                return callback({ status: "success", message: "Station enrolled successfully", payload: resolved(existing) });

            const station = await db.station.create({
                ...normalizeStation(payload?.station),
                stationId,
                lastSeenAt: new Date(),
            });
            callback({ status: "success", message: "Station enrolled successfully", payload: resolved(station) });
        } catch (error) {
            if (error?.code !== 11000) return callback({ status: "error", message: error.message });

            const station = await db.station.findOne({ stationId: normalizeUuid(payload?.stationId) });
            station
                ? callback({ status: "success", message: "Station enrolled successfully", payload: resolved(station) })
                : callback({ status: "error", message: error.message });
        }
    });

    socket.on("station:claim", async (payload, callback) => {
        try {
            const stationId = validateStationId(payload?.stationId);
            if (!mongoose.isValidObjectId(payload?._id)) throw new Error('Invalid station _id');

            const station = await db.station.findById(payload._id);
            if (!station)
                return callback({ status: "success", message: "Station identity conflict", payload: conflict('not-found') });
            if (station.stationId === stationId)
                return callback({ status: "success", message: "Station claimed successfully", payload: resolved(station) });
            if (station.stationId && payload?.replace !== true)
                return callback({ status: "success", message: "Station identity conflict", payload: conflict('owned', [station]) });

            const claimed = await db.station.findOneAndUpdate(
                { _id: station._id, ...(station.stationId ? { stationId: station.stationId } : { stationId: { $exists: false } }) },
                { $set: { stationId, lastSeenAt: new Date() } },
                { new: true, runValidators: true }
            );
            if (claimed)
                return callback({ status: "success", message: "Station claimed successfully", payload: resolved(claimed) });

            const current = await db.station.findById(station._id).select(`${STATION_CONFLICT_FIELDS} stationId`);
            callback({ status: "success", message: "Station identity conflict", payload: conflict('race', current ? [current] : []) });
        } catch (error) {
            if (error?.code !== 11000) return callback({ status: "error", message: error.message });

            const stations = await db.station.find({
                $or: [{ _id: payload?._id }, { stationId: normalizeUuid(payload?.stationId) }],
            }).select(STATION_CONFLICT_FIELDS);
            callback({ status: "success", message: "Station identity conflict", payload: conflict('owned', stations) });
        }
    });

    socket.on("station:release", async (payload, callback) => {
        try {
            const stationId = validateStationId(payload?.stationId);
            if (!mongoose.isValidObjectId(payload?._id)) throw new Error('Invalid station _id');

            const station = await db.station.findOneAndUpdate(
                { _id: payload._id, stationId },
                { $unset: { stationId: 1 } },
                { new: true }
            );
            callback({ status: "success", message: "Station released successfully", payload: { released: !!station } });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

};
