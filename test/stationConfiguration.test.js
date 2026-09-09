const assert = require('node:assert/strict');
const test = require('node:test');

const fixture = (station, options = {}) => {
    const paths = ['../models', '../socket/session', '../socket/event/station', '../socket/event/config', '../utils/stationRelease'].map(require.resolve);
    const { getStationUpdate } = require(paths[4]);
    const previous = paths.map(path => require.cache[path]);
    require.cache[paths[0]] = { id: paths[0], filename: paths[0], loaded: true, exports: { station } };
    require.cache[paths[1]] = { id: paths[1], filename: paths[1], loaded: true, exports: {
        getActiveSessionUser: async () => {
            if (options.signedOut) throw new Error('Sign in to continue');
            return {};
        },
        hasPermission: () => options.allowed !== false,
    } };
    delete require.cache[paths[2]];
    delete require.cache[paths[3]];
    require.cache[paths[4]] = { id: paths[4], filename: paths[4], loaded: true, exports: {
        getStationUpdate, getLatestRelease: async request => {
            options.releaseRequests?.push(request);
            return options.release || { version: '26.3318.1', error: '' };
        },
    } };
    const handlers = {};
    const emitted = [];
    const socket = { connected: true, data: {}, handshake: { address: '127.0.0.1' },
        on: (event, handler) => { handlers[event] = handler; }, emit: (event, data) => emitted.push({ event, data }) };
    const io = { sockets: { sockets: new Map([['socket', socket]]) } };
    try {
        require(paths[2])(socket, io);
        require(paths[3])(socket, io);
    } finally {
        paths.forEach((path, index) => previous[index] ? require.cache[path] = previous[index] : delete require.cache[path]);
    }
    return { socket, io, emitted, handlers, call: (event, payload = {}) => new Promise(resolve => handlers[event](payload, resolve)) };
};
const identity = '123e4567-e89b-42d3-a456-426614174000';
const record = { _id: '507f1f77bcf86cd799439011', stationId: identity, name: 'Line 1', location: 'Floor', application: 'SOFTWARE',
    computer: { appVersion: '26.3317.1990' } };

test('station resolution, telemetry and disconnect push the current roster to subscribed viewers', async () => {
    const chain = { sort: () => chain, lean: async () => [record] };
    const env = fixture({ find: () => chain, findOneAndUpdate: async () => record });
    const updates = [];
    const viewer = { connected: true, data: { stationsViewer: 1, sessionGeneration: 1 },
        emit: (event, payload) => updates.push({ event, payload }) };
    env.io.sockets.sockets.set('viewer', viewer);
    await env.call('station:resolve', { stationId: identity });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(updates.at(-1).event, 'stations:changed');
    assert.equal(updates.at(-1).payload[0].online, true);
    await env.call('station:heartbeat', { _id: record._id, stationId: identity, liveSupported: true,
        deployment: { status: 'downloading' } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(updates.at(-1).payload[0].liveSupported, true);
    assert.equal(updates.at(-1).payload[0].deployment.status, 'downloading');
    env.socket.connected = false;
    env.handlers.disconnect();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(updates.at(-1).payload[0].online, false);
    assert.equal(updates.at(-1).payload[0].deployment, null);
});

test('roster subscription ends on leaving the page and rejects changed sessions or permissions', async () => {
    const chain = { sort: () => chain, lean: async () => [record] };
    const options = {};
    const env = fixture({ find: () => chain, findOneAndUpdate: async () => record }, options);
    env.socket.data.sessionGeneration = 1;
    await env.call('stations:get');
    assert.equal(env.socket.data.stationsViewer, 1);
    await env.call('station:resolve', { stationId: identity });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(env.emitted.filter(item => item.event === 'stations:changed').length, 1);
    env.handlers['stations:unsubscribe']();
    await env.call('station:resolve', { stationId: identity });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(env.emitted.length, 1);
    await env.call('stations:get');
    env.socket.data.sessionGeneration++;
    await env.call('station:resolve', { stationId: identity });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(env.emitted.length, 1);
    await env.call('stations:get');
    options.allowed = false;
    await env.call('station:resolve', { stationId: identity });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(env.emitted.length, 1);
});

test('heartbeat binds only the matching station and bounds computer data', async () => {
    let update;
    const env = fixture({ findOneAndUpdate: async (filter, data) => {
        assert.deepEqual(filter, { _id: record._id, stationId: identity });
        update = data.$set;
        return { ...record, ...update };
    } });
    const response = await env.call('station:heartbeat', { _id: record._id, stationId: identity, computer: {
        hostname: 'x'.repeat(300), cpuCount: -1, memoryBytes: 16000, ipAddresses: ['10.0.0.1', '10.0.0.1', 'not-an-ip', '::1'],
        remoteAddress: 'spoofed', password: 'must not persist',
    } });
    assert.equal(response.status, 'success');
    assert.equal(update.computer.hostname.length, 256);
    assert.deepEqual(update.computer.ipAddresses, ['10.0.0.1']);
    assert.equal(update.computer.cpuCount, 0);
    assert.equal(update.computer.remoteAddress, '127.0.0.1');
    assert.equal(update.computer.password, undefined);
    assert.equal(update.computer.disks, null);
    assert.equal(update.computer.devices.cameras, null);
    assert.equal(env.socket.data.stationPresence.stationId, identity);
});

test('a released or replaced identity cannot report online', async () => {
    const env = fixture({ findOneAndUpdate: async () => null });
    env.socket.data.stationPresence = { _id: record._id, stationId: identity };
    const response = await env.call('station:heartbeat', { _id: record._id, stationId: identity });
    assert.equal(response.status, 'error');
    assert.equal(env.socket.data.stationPresence, undefined);
});

test('roster uses live sockets despite delayed telemetry and excludes disconnected or replaced connections', async () => {
    const chain = { sort: () => chain, lean: async () => [record] };
    const env = fixture({ find: () => chain });
    env.socket.data.stationPresence = { _id: record._id, stationId: identity, at: Date.now() };
    assert.equal((await env.call('stations:get')).payload[0].online, true);
    env.socket.connected = false;
    assert.equal((await env.call('stations:get')).payload[0].online, false);
    env.socket.connected = true;
    env.socket.data.stationPresence.at = Date.now() - 91000;
    assert.equal((await env.call('stations:get')).payload[0].online, true);
    env.socket.data.stationPresence = { _id: record._id, stationId: 'replaced', at: Date.now() };
    assert.equal((await env.call('stations:get')).payload[0].online, false);
});

test('configuration requires an authorized operator', async () => {
    for (const options of [{ allowed: false }, { signedOut: true }]) {
        const env = fixture({}, options);
        assert.equal((await env.call('stations:get')).status, 'error');
        assert.equal((await env.call('station:update', { _id: record._id, name: 'Renamed' })).status, 'error');
        assert.equal((await env.call('station:deploy', { _id: record._id })).status, 'error');
    }
});

test('heartbeat validates disk sizes and distinguishes missing from empty device inventories', async () => {
    let computer;
    const env = fixture({ findOneAndUpdate: async (_filter, update) => {
        computer = update.$set.computer;
        return { ...record, ...update.$set };
    } });
    await env.call('station:heartbeat', { _id: record._id, stationId: identity, computer: {
        disks: [{ name: 'C:', totalBytes: 1000, availableBytes: 0, label: 'System' },
            { name: 'bad', totalBytes: 100, availableBytes: 101 }, { name: 'bad', totalBytes: -1, availableBytes: 0 }, null],
        devices: { cameras: [], speakers: [' Speaker ', 'Speaker', 'x'.repeat(300), null, ''], microphones: 'invalid' },
    } });
    assert.deepEqual(computer.disks, [{ name: 'C:', label: 'System', totalBytes: 1000, availableBytes: 0 }]);
    assert.deepEqual(computer.devices.cameras, []);
    assert.deepEqual(computer.devices.speakers, ['Speaker', 'x'.repeat(256)]);
    assert.equal(computer.devices.microphones, null);
});

test('identity resolution registers presence before computer telemetry and disconnect removes it', async () => {
    const chain = { sort: () => chain, lean: async () => [record] };
    const env = fixture({ find: () => chain, findOneAndUpdate: async () => record });
    assert.equal((await env.call('station:resolve', { stationId: identity })).status, 'success');
    assert.equal((await env.call('stations:get')).payload[0].online, true);
    assert.equal(env.socket.data.stationPresence, undefined);
    env.socket.connected = false;
    assert.equal((await env.call('stations:get')).payload[0].online, false);
});

test('legacy station lookup reports live presence without requiring computer or deployment APIs', async () => {
    const legacy = { ...record, stationId: undefined, computer: undefined };
    const chain = { sort: () => chain, lean: async () => [legacy] };
    const env = fixture({ find: () => chain, findOne: async () => legacy });
    await env.call('station:get', { macAddress: 'aa:bb:cc:dd:ee:ff' });
    const result = (await env.call('stations:get')).payload[0];
    assert.equal(result.online, true);
    assert.equal(result.update.remoteDeploySupported, null);
});

test('claiming a different station clears the previous deployment target', async () => {
    const env = fixture({ findById: async () => record });
    env.socket.data.stationPresence = { _id: 'previous', stationId: 'previous-identity', at: Date.now() };
    env.socket.data.stationDeployment = { status: 'idle' };
    assert.equal((await env.call('station:claim', { _id: record._id, stationId: identity })).status, 'success');
    assert.equal(env.socket.data.stationConnection._id, record._id);
    assert.equal(env.socket.data.stationPresence, undefined);
    assert.equal(env.socket.data.stationDeployment, undefined);
});

test('missing computer telemetry preserves the reported version while refreshing presence', async () => {
    const env = fixture({ findOneAndUpdate: async (_filter, update) => {
        assert.equal(update.$set.computer, undefined);
        assert.ok(update.$set.lastSeenAt);
        return record;
    } });
    assert.equal((await env.call('station:heartbeat', { _id: record._id, stationId: identity })).status, 'success');
    assert.equal(env.socket.data.stationConnection._id, record._id);
});

test('release lookup failure leaves live presence available while disabling updates', async () => {
    const chain = { sort: () => chain, lean: async () => [record] };
    const env = fixture({ find: () => chain }, { release: { version: '', error: 'releaseUnavailable' } });
    env.socket.data.stationPresence = { _id: record._id, stationId: identity, at: Date.now() };
    const result = (await env.call('stations:get')).payload[0];
    assert.equal(result.online, true);
    assert.equal(result.update.available, false);
    assert.equal(result.update.error, 'releaseUnavailable');
});

const deploymentTarget = (env, acknowledge = (_event, _payload, callback) => callback(null, { success: true })) => {
    const target = { connected: true, data: {
        stationPresence: { _id: record._id, stationId: identity, at: Date.now() }, stationDeployment: { status: 'idle' },
    }, timeout: milliseconds => {
        assert.equal(milliseconds, 5000);
        return { emit: acknowledge };
    } };
    env.io.sockets.sockets.set('target', target);
    return target;
};

test('server rejects unsupported, unknown, current and newer versions even for direct deployment requests', async () => {
    for (const appVersion of ['26.3317.1989', '', 'invalid', '26.3318.1', '27.1.0']) {
        const env = fixture({ findById: () => ({ lean: async () => ({ ...record, computer: { appVersion } }) }) });
        deploymentTarget(env, () => assert.fail('Must not dispatch'));
        assert.equal((await env.call('station:deploy', { _id: record._id })).status, 'error');
        assert.equal((await env.call('station:delete', { _id: record._id })).status, 'error');
        assert.equal((await env.call('station:screenshot:get', { _id: record._id })).status, 'error');
        assert.equal((await env.call('station:screenshot:capture', { _id: record._id })).status, 'error');
        assert.equal((await env.call('station:update', { _id: record._id, screenshotsEnabled: false })).status, 'error');
    }
    const env = fixture({ findById: () => ({ lean: async () => record }) }, { release: { version: '', error: 'releaseUnavailable' } });
    deploymentTarget(env, () => assert.fail('Must not dispatch'));
    assert.equal((await env.call('station:deploy', { _id: record._id })).status, 'error');
});

test('station deletion removes only the selected database record and clears connected bindings', async () => {
    const ids = [];
    const env = fixture({ findByIdAndDelete: async id => { ids.push(id); return record; } });
    env.socket.data.stationPresence = { _id: record._id, stationId: identity };
    env.socket.data.stationConnection = { _id: record._id, stationId: identity };
    env.socket.data.stationDeployment = { status: 'idle' };
    const legacyEvents = [];
    const legacy = { data: { stationConnection: { _id: record._id, stationId: null } }, emit: event => legacyEvents.push(event) };
    const other = { data: { stationConnection: { _id: 'another-station' } }, emit: () => {} };
    env.io.sockets.sockets.set('legacy', legacy);
    env.io.sockets.sockets.set('other', other);
    const result = await env.call('station:delete', { _id: record._id, stationId: 'ignored', name: 'ignored' });
    assert.equal(result.status, 'success');
    assert.deepEqual(ids, [record._id]);
    assert.deepEqual(result.payload, { _id: record._id });
    assert.equal(env.socket.data.stationPresence, undefined);
    assert.equal(env.socket.data.stationConnection, undefined);
    assert.equal(env.socket.data.stationDeployment, undefined);
    assert.equal(legacy.data.stationConnection, undefined);
    assert.equal(other.data.stationConnection._id, 'another-station');
    assert.ok(legacyEvents.includes('station:delete'));
    assert.deepEqual(env.emitted.find(event => event.event === 'station:delete').data, { _id: record._id });
});

test('invalid deletion requests never reach the database', async () => {
    const env = fixture({ findByIdAndDelete: async () => assert.fail('Unexpected database deletion') });
    for (const _id of [undefined, '', 'invalid', { $ne: null }, 123])
        assert.equal((await env.call('station:delete', { _id })).status, 'error');
    assert.equal(env.emitted.length, 0);
});

test('missing records and database errors do not notify clients or clear bindings', async () => {
    for (const throws of [false, true]) {
        const env = fixture({ findByIdAndDelete: async () => {
            if (throws) throw new Error('Database unavailable');
            return null;
        } });
        env.socket.data.stationConnection = { _id: record._id, stationId: identity };
        const result = await env.call('station:delete', { _id: record._id });
        assert.equal(result.status, 'error');
        assert.equal(result.message, throws ? 'Database unavailable' : 'Station not found');
        assert.equal(env.socket.data.stationConnection._id, record._id);
        assert.equal(env.emitted.length, 0);
    }
});

test('privacy updates validate booleans, increment generation and leave omitted settings untouched', async () => {
    const updates = [];
    const station = { ...record, screenshotsEnabled: true, screenshotGeneration: 0 };
    const env = fixture({
        findByIdAndUpdate: async (_id, update) => {
            updates.push(update);
            Object.assign(station, update.$set);
            station.screenshotGeneration += update.$inc?.screenshotGeneration || 0;
            return { ...station };
        },
        findById: () => ({ lean: async () => ({ ...station }) }),
    });
    assert.equal((await env.call('station:update', { _id: record._id, screenshotsEnabled: 'false' })).status, 'error');
    assert.equal(updates.length, 0);
    assert.equal((await env.call('station:update', { _id: record._id, screenshotsEnabled: false })).status, 'success');
    assert.equal(station.screenshotsEnabled, false);
    assert.equal(station.screenshotGeneration, 1);
    assert.equal((await env.call('station:update', { _id: record._id, name: 'Updated' })).status, 'success');
    assert.equal(updates.at(-1).$set.screenshotsEnabled, undefined);
    assert.equal(updates.at(-1).$inc, undefined);
    assert.equal(station.screenshotsEnabled, false);
});

test('legacy station creation cannot seed private screenshot metadata or cleanup paths', async () => {
    let created;
    const env = fixture({ create: async data => { created = data; return data; } });
    const response = await env.call('station:create', { name: 'New station', location: 'Floor', application: 'SOFTWARE',
        screenshotCleanup: ['../../private'], screenshot: { revision: 'spoofed' }, screenshotSupported: true,
        screenshotGeneration: 100, screenshotsEnabled: false });
    assert.equal(response.status, 'success');
    assert.deepEqual(created, { name: 'New station', location: 'Floor', application: 'SOFTWARE' });
});

test('deployment targets only the currently linked station and records acceptance', async () => {
    const env = fixture({ findById: id => { assert.equal(id, record._id); return { lean: async () => record }; } });
    const target = deploymentTarget(env, (event, payload, callback) => {
        assert.equal(event, 'station:deploy');
        assert.deepEqual(payload, { _id: record._id, stationId: identity, version: '26.3318.1' });
        callback(null, { success: true });
    });
    const result = await env.call('station:deploy', { _id: record._id, url: 'https://untrusted.invalid/installer.exe' });
    assert.equal(result.status, 'success');
    assert.equal(result.payload.deployment.status, 'checking');
    assert.equal(target.data.deploying, false);
    assert.equal(env.emitted.length, 0);
});

test('deployment rejects offline, replaced, unsupported, and busy stations', async () => {
    for (const modify of [
        target => { target.connected = false; },
        target => { target.data.stationPresence.stationId = 'replaced'; },
        target => { target.data.stationDeployment = null; },
        target => { target.data.stationDeployment.status = 'downloading'; },
    ]) {
        const env = fixture({ findById: () => ({ lean: async () => record }) });
        const target = deploymentTarget(env, () => assert.fail('Must not dispatch'));
        modify(target);
        assert.equal((await env.call('station:deploy', { _id: record._id })).status, 'error');
    }
});

test('deployment refreshes release discovery and rejects a version different from the operator selection', async () => {
    const releaseRequests = [];
    const env = fixture({ findById: () => ({ lean: async () => record }) }, { releaseRequests });
    deploymentTarget(env, () => assert.fail('Must not deploy an unreviewed release'));
    const result = await env.call('station:deploy', { _id: record._id, version: '26.3317.9999' });
    assert.equal(result.status, 'error');
    assert.match(result.message, /latest release changed/);
    assert.equal(releaseRequests[0].force, true);
});

test('failed or missing client acknowledgments are not reported as successful deployments', async () => {
    for (const [error, response] of [[new Error('timeout')], [null, { success: false, error: 'Updater busy' }]]) {
        const env = fixture({ findById: () => ({ lean: async () => record }) });
        const target = deploymentTarget(env, (_event, _payload, callback) => callback(error, response));
        assert.equal((await env.call('station:deploy', { _id: record._id })).status, 'error');
        assert.equal(target.data.deploying, false);
    }
});

test('retry acceptance clears old failure status without overwriting newer client reports', async () => {
    for (const reportsProgress of [false, true]) {
        const env = fixture({ findById: () => ({ lean: async () => record }) });
        const target = deploymentTarget(env, (_event, _payload, callback) => {
            if (reportsProgress) target.data.stationDeployment = { status: 'downloading', version: '2.0.0' };
            callback(null, { success: true });
        });
        target.data.stationDeployment = { status: 'failed', error: 'Previous error' };
        const result = await env.call('station:deploy', { _id: record._id });
        assert.equal(result.payload.deployment.status, reportsProgress ? 'downloading' : 'checking');
        assert.equal(result.payload.deployment.error, undefined);
    }
});

test('concurrent requests cannot dispatch the same deployment twice', async () => {
    let finish;
    const env = fixture({ findById: () => ({ lean: async () => record }) });
    deploymentTarget(env, (_event, _payload, callback) => { finish = callback; });
    const first = env.call('station:deploy', { _id: record._id });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal((await env.call('station:deploy', { _id: record._id })).status, 'error');
    finish(null, { success: true });
    assert.equal((await first).status, 'success');
});

test('heartbeat reports bounded deployment status without adding it to the database record', async () => {
    const chain = { sort: () => chain, lean: async () => [record] };
    const env = fixture({ find: () => chain, findOneAndUpdate: async (_filter, update) => {
        assert.equal(update.$set.deployment, undefined);
        return record;
    } });
    await env.call('station:heartbeat', { _id: record._id, stationId: identity,
        deployment: { status: 'failed', error: 'x'.repeat(900), version: '2.0.0', command: 'ignored' } });
    const result = (await env.call('stations:get')).payload[0];
    assert.equal(result.deployment.status, 'failed');
    assert.equal(result.deployment.error.length, 500);
    assert.equal(result.deployment.command, undefined);
    env.socket.connected = false;
    assert.equal((await env.call('stations:get')).payload[0].deployment, null);
});

test('station update protects identity and telemetry and delivers settings to the linked station', async () => {
    let update;
    const env = fixture({ findByIdAndUpdate: async (_id, data, options) => {
        assert.equal(_id, record._id);
        assert.equal(options.runValidators, true);
        update = data.$set;
        return { ...record, ...update };
    } });
    env.socket.data.stationPresence = { _id: record._id, stationId: identity };
    const response = await env.call('station:update', { _id: record._id, name: ' New name ', stationId: 'overwrite',
        computer: { hostname: 'spoof' }, lastSeenAt: new Date(), online: true });
    assert.equal(response.status, 'success');
    assert.deepEqual(update, { name: 'New name' });
    assert.equal(env.emitted.length, 1);
    assert.equal(env.emitted[0].event, 'station:update');
});

test('invalid station settings and missing records return errors', async () => {
    const env = fixture({ findByIdAndUpdate: async () => null });
    for (const data of [{ name: ' ' }, { allowedModules: ['UNKNOWN'] },
        { config: { boardType: 'bulletin', bulletin: { pages: [], rotateSeconds: 0 } } }, { name: 'Missing' }])
        assert.equal((await env.call('station:update', { _id: record._id, ...data })).status, 'error');
});

test('a station may update its own bulletin but cannot update another station without permission', async () => {
    const env = fixture({ exists: async () => true, findByIdAndUpdate: async (_id, data) => ({ ...record, ...data.$set }) }, { signedOut: true });
    env.socket.data.stationPresence = { _id: record._id, stationId: identity };
    const config = { boardType: 'bulletin', departmentId: '507f1f77bcf86cd799439012',
        bulletin: { pages: ['schedule'], rotateSeconds: 20, teamIds: [] } };
    assert.equal((await env.call('station:update', { _id: record._id, config })).status, 'success');
    assert.equal((await env.call('station:update', { _id: 'other', config })).status, 'error');
    assert.equal((await env.call('station:update', { _id: record._id, name: 'Not permitted' })).status, 'error');
});
