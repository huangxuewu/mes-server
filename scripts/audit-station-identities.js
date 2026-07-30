const database = require("../config/database");
const Station = require("../models/station");

const APPLICATIONS = new Set(["PORTAL", "SOFTWARE", "SIGNAGE", "VISITOR", "TIMECARD", "LOADBOARD"]);
const STATUSES = new Set(["Active", "Inactive", "Disabled"]);
const normalizeMacAddress = address =>
    String(address || "").trim().toLowerCase().replace(/[^0-9a-f]/g, "").match(/.{2}/g)?.join(":") || "";

const run = async () => {
    await database.connection.asPromise();
    const stations = await Station.find({}).lean();
    const byMacAddress = new Map();

    stations.forEach(station => {
        const macAddress = normalizeMacAddress(station.macAddress);
        if (!macAddress) return;
        byMacAddress.set(macAddress, [...(byMacAddress.get(macAddress) || []), station]);
    });

    const summarize = station => ({
        _id: String(station._id),
        name: station.name,
        location: station.location,
        application: station.application,
        status: station.status,
        macAddress: station.macAddress,
        stationId: station.stationId || null,
    });

    const report = {
        total: stations.length,
        enrolled: stations.filter(station => station.stationId).length,
        unregistered: stations.filter(station => !station.stationId).map(summarize),
        duplicateMacAddresses: [...byMacAddress]
            .filter(([, matches]) => matches.length > 1)
            .map(([macAddress, matches]) => ({ macAddress, stations: matches.map(summarize) })),
        invalidConfiguration: stations
            .filter(station => !APPLICATIONS.has(station.application) || !STATUSES.has(station.status))
            .map(summarize),
    };

    console.log(JSON.stringify(report, null, 2));
    await database.connection.close();
};

run().catch(async error => {
    console.error(error);
    await database.connection.close();
    process.exitCode = 1;
});
