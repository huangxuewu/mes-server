const assert = require("node:assert/strict");
const test = require("node:test");

const loadHandlers = station => {
    const modelsPath = require.resolve("../models");
    const handlerPath = require.resolve("../socket/event/config");
    const previousModels = require.cache[modelsPath];

    require.cache[modelsPath] = { id: modelsPath, filename: modelsPath, loaded: true, exports: { station } };
    delete require.cache[handlerPath];
    const register = require(handlerPath);
    const handlers = {};
    register({ on: (event, handler) => { handlers[event] = handler; } }, {});

    previousModels ? require.cache[modelsPath] = previousModels : delete require.cache[modelsPath];
    delete require.cache[handlerPath];
    return handlers;
};

const call = (handler, payload) => new Promise(resolve => handler(payload, resolve));

test("station enrollment is idempotent during concurrent requests", async () => {
    const records = new Map();
    const station = {
        findOneAndUpdate: async query => records.get(query.stationId) || null,
        findOne: async query => records.get(query.stationId) || null,
        create: async data => {
            await new Promise(resolve => setImmediate(resolve));
            if (records.has(data.stationId)) throw Object.assign(new Error("duplicate"), { code: 11000 });
            const record = { _id: "station-1", ...data };
            records.set(data.stationId, record);
            return record;
        },
    };
    const handlers = loadHandlers(station);
    const payload = {
        stationId: "123e4567-e89b-42d3-a456-426614174000",
        station: {
            name: "Line 1",
            location: "Production",
            application: "SOFTWARE",
            status: "Active",
        },
    };

    const [first, second] = await Promise.all([
        call(handlers["station:enroll"], payload),
        call(handlers["station:enroll"], payload),
    ]);

    assert.equal(records.size, 1);
    assert.equal(first.status, "success");
    assert.equal(second.status, "success");
    assert.equal(first.payload.outcome, "resolved");
    assert.equal(second.payload.outcome, "resolved");
    assert.equal(first.payload.station._id, second.payload.station._id);
});

test("station resolve does not use MAC migration after reset", async () => {
    const chain = {
        select: () => chain,
        sort: () => chain,
        limit: () => chain,
        lean: async () => [],
    };
    const station = {
        findOneAndUpdate: async () => null,
        find: () => chain,
    };
    const handlers = loadHandlers(station);
    const response = await call(handlers["station:resolve"], {
        stationId: "123e4567-e89b-42d3-a456-426614174000",
        macAddresses: ["aa:bb:cc:dd:ee:ff"],
        allowLegacyMigration: false,
    });

    assert.equal(response.status, "success");
    assert.deepEqual(response.payload, { outcome: "unconfigured", stations: [] });
});

test("station claim returns the explicit resolved contract", async () => {
    const record = {
        _id: "507f1f77bcf86cd799439011",
        name: "Line 2",
        location: "Production",
        application: "SOFTWARE",
    };
    const station = {
        findById: async () => record,
        findOneAndUpdate: async () => ({ ...record, stationId: "123e4567-e89b-42d3-a456-426614174000" }),
    };
    const handlers = loadHandlers(station);
    const response = await call(handlers["station:claim"], {
        stationId: "123e4567-e89b-42d3-a456-426614174000",
        _id: record._id,
    });

    assert.equal(response.status, "success");
    assert.equal(response.payload.outcome, "resolved");
    assert.equal(response.payload.station._id, record._id);
});
