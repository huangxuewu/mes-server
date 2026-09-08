const assert = require('node:assert/strict');
const test = require('node:test');

const fixture = (station, options = {}) => {
    const paths = ['../models', '../socket/session', '../socket/event/station', '../socket/event/config'].map(require.resolve);
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
    return { socket, io, emitted, call: (event, payload = {}) => new Promise(resolve => handlers[event](payload, resolve)) };
};
const identity = '123e4567-e89b-42d3-a456-426614174000';
const record = { _id: '507f1f77bcf86cd799439011', stationId: identity, name: 'Line 1', location: 'Floor', application: 'SOFTWARE' };

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
    assert.deepEqual(update.computer.ipAddresses, ['10.0.0.1', '::1']);
    assert.equal(update.computer.cpuCount, 0);
    assert.equal(update.computer.remoteAddress, '127.0.0.1');
    assert.equal(update.computer.password, undefined);
    assert.equal(env.socket.data.stationPresence.stationId, identity);
});

test('a released or replaced identity cannot report online', async () => {
    const env = fixture({ findOneAndUpdate: async () => null });
    env.socket.data.stationPresence = { _id: record._id, stationId: identity };
    const response = await env.call('station:heartbeat', { _id: record._id, stationId: identity });
    assert.equal(response.status, 'error');
    assert.equal(env.socket.data.stationPresence, undefined);
});

test('roster distinguishes current, stale, disconnected and replaced connections', async () => {
    const chain = { sort: () => chain, lean: async () => [record] };
    const env = fixture({ find: () => chain });
    env.socket.data.stationPresence = { _id: record._id, stationId: identity, at: Date.now() };
    assert.equal((await env.call('stations:get')).payload[0].online, true);
    env.socket.connected = false;
    assert.equal((await env.call('stations:get')).payload[0].online, false);
    env.socket.connected = true;
    env.socket.data.stationPresence.at = Date.now() - 91000;
    assert.equal((await env.call('stations:get')).payload[0].online, false);
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

test('deployment targets only the currently linked station and records acceptance', async () => {
    const env = fixture({ findById: id => { assert.equal(id, record._id); return { lean: async () => record }; } });
    const target = deploymentTarget(env, (event, payload, callback) => {
        assert.equal(event, 'station:deploy');
        assert.deepEqual(payload, { _id: record._id, stationId: identity });
        callback(null, { success: true });
    });
    const result = await env.call('station:deploy', { _id: record._id, url: 'https://untrusted.invalid/installer.exe' });
    assert.equal(result.status, 'success');
    assert.equal(result.payload.deployment.status, 'checking');
    assert.equal(target.data.deploying, false);
    assert.equal(env.emitted.length, 0);
});

test('deployment rejects offline, stale, replaced, unsupported, and busy stations', async () => {
    for (const modify of [
        target => { target.connected = false; },
        target => { target.data.stationPresence.at = Date.now() - 91000; },
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
