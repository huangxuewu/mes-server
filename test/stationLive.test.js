const test = require('node:test');
const assert = require('node:assert/strict');
const { createStationLive } = require('../utils/stationLive');
const { validateImage } = require('../utils/stationScreenshots');
const jpeg = require('canvas').createCanvas(640, 360).toBuffer('image/jpeg');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const fixture = (options = {}) => {
    let clock = 100000;
    let allowed = true;
    const counts = { reads: 0, authorizations: 0, decodes: 0 };
    const station = { _id: '507f1f77bcf86cd799439011', stationId: 'identity', screenshotsEnabled: true, screenshotGeneration: 0, status: 'Active' };
    const events = [], commands = [], refreshes = [];
    const viewer = { id: 'viewer', connected: true, data: { sessionGeneration: 1 }, emit: (event, data) => events.push({ recipient: 'viewer', event, data }) };
    const target = { id: 'target', connected: true, data: { liveSupported: true, stationPresence: { _id: station._id, stationId: station.stationId, at: 1 } },
        emit: (event, data) => events.push({ recipient: 'target', event, data }),
        timeout: () => ({ emit: async (_event, input, callback) => {
            commands.push(input);
            if (options.command) return options.command(input, callback);
            callback(null, input.type === 'frame' ? { success: true, contents: jpeg } : { success: true, chatImages: true });
        } }) };
    const io = { sockets: { sockets: new Map([['viewer', viewer], ['target', target]]) } };
    const service = createStationLive({ io, db: { station: { findById: () => ({ lean: async () => { counts.reads++; return structuredClone(station); } }) } },
        now: () => clock, validateImage: async bytes => { counts.decodes++; if (options.validateImage) await options.validateImage(); return validateImage(bytes); },
        refreshScreenshot: async request => { refreshes.push(request); },
        authorize: async () => { counts.authorizations++; if (!allowed) throw new Error('accessDenied'); return { displayName: 'Operator' }; } });
    return { service, station, viewer, target, io, events, commands, refreshes, counts, advance: milliseconds => { clock += milliseconds; }, deny: () => { allowed = false; },
        start: options => service.start(viewer, station._id, options) };
};

test('video is negotiated by both peers, relays bounded SDP, validates leases and preserves JPEG fallback', async () => {
    const env = fixture({ command: (input, callback) => callback(null, input.type === 'frame' ? { success: true, contents: jpeg }
        : { success: true, videoProtocol: 1, sdp: 'v=0\r\no=answer', active: true }) });
    const session = await env.start({ frameProtocol: 2, videoProtocol: 1 });
    assert.equal(session.videoProtocol, 1);
    await assert.rejects(env.service.video({ ...env.viewer }, { sessionId: session.sessionId, operation: 'offer', sdp: 'v=0\r\no=offer' }), /ended/);
    await assert.rejects(env.service.video(env.viewer, { sessionId: session.sessionId, operation: 'offer', sdp: 'x'.repeat(65537) }), /invalidAction/);
    const answer = await env.service.video(env.viewer, { sessionId: session.sessionId, operation: 'offer', sdp: 'v=0\r\no=offer' });
    assert.equal(answer.sdp, 'v=0\r\no=answer');
    assert.equal(env.commands.at(-1).type, 'video');
    await assert.rejects(env.service.video(env.viewer, { sessionId: session.sessionId, operation: 'offer', sdp: 'v=0\r\no=again' }), /invalidAction/);
    env.advance(10000);
    assert.equal((await env.service.video(env.viewer, { sessionId: session.sessionId, operation: 'heartbeat' })).active, true);
    await env.service.video(env.viewer, { sessionId: session.sessionId, operation: 'stop' });
    assert.equal((await env.service.frame(env.viewer, session.sessionId)).contents.length, jpeg.length);
    env.station.screenshotsEnabled = false;
    await assert.rejects(env.service.video(env.viewer, { sessionId: session.sessionId, operation: 'heartbeat' }), /privacyChanged/);
    assert.equal(env.service.sessions.size, 0);
});

test('legacy clients omit video capability and stopped/ended negotiations cannot deliver late answers', async () => {
    const oldStation = fixture();
    assert.equal((await oldStation.start({ videoProtocol: 1 })).videoProtocol, undefined);
    const pending = deferred();
    const env = fixture({ command: async (input, callback) => {
        if (input.type === 'video' && input.operation === 'offer') await pending.promise;
        callback(null, { success: true, videoProtocol: 1, sdp: 'v=0\r\no=answer' });
    } });
    const session = await env.start({ videoProtocol: 1 });
    const offer = env.service.video(env.viewer, { sessionId: session.sessionId, operation: 'offer', sdp: 'v=0\r\no=offer' });
    await new Promise(resolve => setImmediate(resolve));
    await env.service.video(env.viewer, { sessionId: session.sessionId, operation: 'stop' });
    pending.resolve(); await assert.rejects(offer, /ended/);
    assert.equal(env.service.sessions.size, 1);
    env.service.stop(env.viewer, session.sessionId);
    await assert.rejects(env.service.video(env.viewer, { sessionId: session.sessionId, operation: 'heartbeat' }), /ended/);
});

test('live sessions stream validated desktop frames and route annotations and two-way chat to the linked station', async () => {
    const env = fixture();
    const { sessionId } = await env.start();
    assert.equal(env.commands[0].type, 'start');
    assert.equal(env.commands[0].stationId, env.station.stationId);
    const frame = await env.service.frame(env.viewer, sessionId);
    assert.deepEqual([frame.width, frame.height], [640, 360]);
    assert.ok(frame.contents.equals(jpeg));
    for (const action of [{ type: 'pointer', points: [[.2, .7]] }, { type: 'draw', points: [[0, 0], [1, 1]] },
        { type: 'clear' }, { type: 'chat', enabled: true }, { type: 'message', text: 'Check this area' }])
        await env.service.action(env.viewer, { sessionId, ...action });
    await env.service.remoteMessage(env.target, { sessionId, text: 'I see it' });
    assert.equal(env.events.find(event => event.event === 'station:live:message').data.text, 'I see it');
    await env.service.action(env.viewer, { sessionId, type: 'chat', enabled: false });
    await assert.rejects(env.service.remoteMessage(env.target, { sessionId, text: 'late' }), /chatEnded/);
    env.service.stop(env.viewer, sessionId);
    assert.equal(env.service.sessions.size, 0);
    assert.ok(env.events.some(event => event.recipient === 'target' && event.event === 'station:live:ended'));
});

test('selected monitor is forwarded and must be acknowledged by the station', async () => {
    const env = fixture({ command: (input, callback) => callback(null, { success: true, displayId: input.displayId }) });
    const session = await env.start({ displayId: '7' });
    assert.equal(env.commands[0].displayId, '7');
    env.service.stop(env.viewer, session.sessionId);
    const legacy = fixture();
    await assert.rejects(legacy.start({ displayId: '7' }), /updateRequired/);
    assert.equal(legacy.service.sessions.size, 0);
    for (const displayId of ['../screen', 7, {}, '']) await assert.rejects(env.start({ displayId }), /invalidAction/);
});

test('ending established Live requests one fresh screenshot even when either participant disconnects', async () => {
    for (const participant of ['stop', 'viewer', 'target']) {
        const env = fixture();
        const { sessionId } = await env.start();
        if (participant === 'stop') env.service.stop(env.viewer, sessionId);
        else { env[participant].connected = false; env.service.stopForSocket(env[participant].id); }
        env.service.stopForSocket(env.viewer.id);
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(env.refreshes, [{ _id: env.station._id, stationId: env.station.stationId, generation: 0 }]);
        assert.equal(env.service.sessions.size, 0);
        assert.ok(env.events.some(event => event.recipient === 'target' && event.event === 'station:live:ended'));
    }
    const failed = fixture({ command: (_input, callback) => callback(null, { success: false, error: 'busy' }) });
    await assert.rejects(failed.start(), /busy/);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(failed.refreshes.length, 0);
});

test('cropped chat images are validated, bounded and sent only to the active linked station', async () => {
    const env = fixture();
    const { sessionId, chatImages } = await env.start();
    assert.equal(chatImages, true);
    const message = { sessionId, type: 'message', text: '', image: { mime: 'image/jpeg', contents: jpeg } };
    await assert.rejects(env.service.action(env.viewer, message), /chatEnded/);
    await env.service.action(env.viewer, { sessionId, type: 'chat', enabled: true });
    for (const image of [{ mime: 'image/svg+xml', contents: jpeg }, { mime: 'image/jpeg', contents: Buffer.from('bad') },
        { mime: 'image/jpeg', contents: Buffer.alloc(1024 * 1024 + 1) }])
        await assert.rejects(env.service.action(env.viewer, { ...message, image }), /invalidImage/);
    assert.equal(env.commands.filter(command => command.type === 'message').length, 0);
    await env.service.action(env.viewer, message);
    const delivered = env.commands.at(-1).image;
    assert.equal(delivered.width, 640); assert.equal(delivered.height, 360);
    assert.ok(delivered.contents.equals(jpeg));
    for (let index = 1; index < 10; index++) { env.advance(1000); await env.service.action(env.viewer, message); }
    env.advance(1000);
    await assert.rejects(env.service.action(env.viewer, message), /imageLimit/);
    env.station.screenshotsEnabled = false;
    await assert.rejects(env.service.action(env.viewer, message), /privacyChanged/);
});

test('older station clients reject chat attachments without losing text chat', async () => {
    const env = fixture({ command: (_input, callback) => callback(null, { success: true }) });
    const { sessionId, chatImages } = await env.start();
    assert.equal(chatImages, false);
    await env.service.action(env.viewer, { sessionId, type: 'chat', enabled: true });
    await assert.rejects(env.service.action(env.viewer, { sessionId, type: 'message', text: '', image: { mime: 'image/jpeg', contents: jpeg } }), /updateRequired/);
    await env.service.action(env.viewer, { sessionId, type: 'message', text: 'Still supported' });
});

test('privacy changes during chat image validation prevent delivery', async () => {
    const validating = deferred(), resume = deferred();
    const env = fixture({ validateImage: async () => { validating.resolve(); await resume.promise; } });
    const { sessionId } = await env.start();
    await env.service.action(env.viewer, { sessionId, type: 'chat', enabled: true });
    const pending = env.service.action(env.viewer, { sessionId, type: 'message', text: '', image: { mime: 'image/jpeg', contents: jpeg } });
    await validating.promise;
    env.station.screenshotGeneration++;
    resume.resolve();
    await assert.rejects(pending, /privacyChanged/);
    assert.equal(env.commands.filter(command => command.type === 'message').length, 0);
});

const transferFixture = () => {
    let accepted = false, bytes = 0, holdChunk;
    const env = fixture({ command: (input, callback) => {
        if (input.type !== 'transfer') return callback(null, { success: true, fileTransfer: true });
        const status = input.operation === 'finish' ? 'transferComplete' : input.operation === 'cancel' ? 'transferCancelled' : accepted ? 'transferSending' : 'transferWaiting';
        if (input.operation === 'chunk') bytes += input.contents.length;
        const respond = () => callback(null, { success: true, id: input.id, status, bytes });
        if (input.operation === 'chunk' && holdChunk) holdChunk(respond); else respond();
    } });
    return { ...env, accept: () => { accepted = true; }, hold: fn => { holdChunk = fn; } };
};
const transferOffer = sessionId => ({ sessionId, operation: 'offer', id: require('node:crypto').randomUUID(),
    manifest: { kind: 'file', name: 'file.bin', entries: [{ path: 'file.bin', type: 'file', size: 3 }] } });

test('file relay waits for receiver acceptance, enforces sequential bounded chunks and reports committed progress', async () => {
    const env = transferFixture(), { sessionId, fileTransfer } = await env.start();
    assert.equal(fileTransfer, true);
    await env.service.action(env.viewer, { sessionId, type: 'chat', enabled: true });
    const offer = transferOffer(sessionId);
    assert.equal((await env.service.transfer(env.viewer, offer)).status, 'transferWaiting');
    assert.equal(env.commands.at(-1).manifest.total, 3);
    assert.equal(env.commands.at(-1).manifest.files, 1);
    env.accept(); await env.service.transfer(env.viewer, { ...offer, operation: 'status' });
    const sent = await env.service.transfer(env.viewer, { ...offer, operation: 'chunk', index: 0, offset: 0, contents: Buffer.from('abc') });
    assert.equal(sent.bytes, 3);
    assert.equal((await env.service.transfer(env.viewer, { ...offer, operation: 'finish' })).status, 'transferComplete');
    assert.equal(env.service.sessions.get(sessionId).transfer, null);
});

test('transfer rejects unaccepted bytes, path traversal, oversized chunks and replaced identities', async () => {
    for (const scenario of ['unaccepted', 'path', 'oversized', 'offset', 'privacy']) {
        const env = transferFixture(), { sessionId } = await env.start();
        await env.service.action(env.viewer, { sessionId, type: 'chat', enabled: true });
        const offer = transferOffer(sessionId);
        if (scenario === 'path') {
            offer.manifest.entries[0].path = '../private';
            await assert.rejects(env.service.transfer(env.viewer, offer), /invalidTransfer/); continue;
        }
        await env.service.transfer(env.viewer, offer);
        if (scenario !== 'unaccepted') { env.accept(); await env.service.transfer(env.viewer, { ...offer, operation: 'status' }); }
        if (scenario === 'privacy') env.station.stationId = 'replaced';
        await assert.rejects(env.service.transfer(env.viewer, { ...offer, operation: 'chunk', index: 0,
            offset: scenario === 'offset' ? 1 : 0, contents: scenario === 'oversized' ? Buffer.alloc(256 * 1024 + 1) : Buffer.from('abc') }), /transferNotAccepted|invalidTransfer|privacyChanged/);
        assert.equal(env.commands.filter(input => input.type === 'transfer' && input.operation === 'chunk').length, 0);
    }
});

test('cancelled in-flight transfers ignore late write acknowledgements', async () => {
    const env = transferFixture(), { sessionId } = await env.start();
    await env.service.action(env.viewer, { sessionId, type: 'chat', enabled: true });
    const offer = transferOffer(sessionId); await env.service.transfer(env.viewer, offer);
    env.accept(); await env.service.transfer(env.viewer, { ...offer, operation: 'status' });
    const pending = deferred(); env.hold(pending.resolve);
    const sending = env.service.transfer(env.viewer, { ...offer, operation: 'chunk', index: 0, offset: 0, contents: Buffer.from('abc') });
    const acknowledge = await pending.promise;
    assert.equal((await env.service.transfer(env.viewer, { ...offer, operation: 'cancel' })).status, 'transferCancelled');
    acknowledge();
    await assert.rejects(sending, /transferCancelled/);
    assert.equal(env.service.sessions.get(sessionId).transfer, null);
});

test('live start enforces permissions, privacy, capability, offline state, and one operator per station', async () => {
    for (const [change, reason] of [[env => env.deny(), 'accessDenied'], [env => { env.station.screenshotsEnabled = false; }, 'privacyChanged'],
        [env => { env.station.status = 'Disabled'; }, 'privacyChanged'], [env => { env.target.connected = false; }, 'offline'],
        [env => { env.target.data.liveSupported = false; }, 'updateRequired']]) {
        const env = fixture(); change(env);
        await assert.rejects(env.start(), new RegExp(reason));
        assert.equal(env.commands.length, 0);
    }
    const env = fixture();
    const results = await Promise.allSettled([env.start(), env.start()]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(env.service.sessions.size, 1);
});

test('privacy generation, identities, permissions, and replaced connections invalidate pending frames', async () => {
    for (const change of [env => { env.station.screenshotsEnabled = false; }, env => { env.station.screenshotGeneration += 2; },
        env => { env.station.stationId = 'replaced'; }, env => env.deny(), env => { env.viewer.data.sessionGeneration++; },
        env => { env.io.sockets.sockets.set('replacement', { ...env.target, data: { ...env.target.data,
            stationPresence: { ...env.target.data.stationPresence, at: 2 } } }); }]) {
        const pending = deferred();
        const env = fixture({ command: (input, callback) => input.type === 'frame' ? pending.resolve(callback) : callback(null, { success: true }) });
        const { sessionId } = await env.start();
        const request = env.service.frame(env.viewer, sessionId);
        const callback = await pending.promise;
        change(env);
        callback(null, { success: true, contents: jpeg });
        await assert.rejects(request);
        assert.equal(env.service.sessions.size, 0);
    }
});

test('self Live is rejected for the target socket and separately bound connections', async () => {
    const direct = fixture();
    await assert.rejects(direct.service.start(direct.target, direct.station._id), /selfView/);
    assert.equal(direct.commands.length, 0);
    for (const field of ['stationConnection', 'stationPresence']) {
        for (const binding of [{ _id: '507f1f77bcf86cd799439011', stationId: null }, { _id: 'other', stationId: 'identity' }]) {
            const env = fixture();
            env.viewer.data[field] = binding;
            await assert.rejects(env.start(), /selfView/);
            assert.equal(env.commands.length, 0);
            assert.equal(env.service.sessions.size, 0);
        }
    }
    const other = fixture();
    other.viewer.data.stationConnection = { _id: 'other', stationId: 'other' };
    await other.start();
    assert.equal(other.service.sessions.size, 1);
});

test('viewer rebinding to the target rejects pending starts and frames and ends active sessions', async () => {
    for (const operation of ['start', 'frame', 'active']) {
        const pending = deferred();
        const env = fixture({ command: (input, callback) => input.type === operation ? pending.resolve(callback) : callback(null, { success: true }) });
        const started = env.start();
        const session = operation === 'start' ? null : await started;
        const request = operation === 'frame' ? env.service.frame(env.viewer, session.sessionId) : started;
        const callback = operation === 'active' ? null : await pending.promise;
        env.viewer.data.stationConnection = { _id: env.station._id, stationId: env.station.stationId };
        if (callback) {
            callback(null, { success: true, contents: jpeg });
            await assert.rejects(request, /selfView/);
        } else { env.advance(1000); await env.service.sweep(); }
        assert.equal(env.service.sessions.size, 0);
        assert.ok(env.events.some(event => event.recipient === 'target' && event.data.reason === 'selfView'));
    }
});

test('station settings changes and stale viewer leases end live sessions without waiting for another frame', async () => {
    const env = fixture();
    await env.start();
    env.station.screenshotsEnabled = false;
    await env.service.changed(env.station._id);
    assert.equal(env.service.sessions.size, 0);
    env.station.screenshotsEnabled = true;
    await env.start();
    env.advance(30001);
    await env.service.sweep();
    assert.equal(env.service.sessions.size, 0);
});

test('session ownership, malformed tools, message limits, and capture overlap are rejected', async () => {
    const pending = deferred();
    const env = fixture({ command: (input, callback) => input.type === 'frame' ? pending.resolve(callback) : callback(null, { success: true }) });
    const { sessionId } = await env.start();
    await assert.rejects(env.service.frame({ ...env.viewer }, sessionId), /ended/);
    await assert.rejects(env.service.remoteMessage({ ...env.target }, { sessionId, text: 'spoof' }), /ended/);
    for (const input of [{ type: 'draw', points: [[-1, 0]] }, { type: 'pointer', points: [[NaN, 0]] }, { type: 'chat', enabled: 'yes' }, { type: 'other' }])
        await assert.rejects(env.service.action(env.viewer, { sessionId, ...input }), /invalidAction/);
    await env.service.action(env.viewer, { sessionId, type: 'chat', enabled: true });
    await assert.rejects(env.service.action(env.viewer, { sessionId, type: 'message', text: 'x'.repeat(2001) }), /invalidMessage/);
    const request = env.service.frame(env.viewer, sessionId);
    const callback = await pending.promise;
    await assert.rejects(env.service.frame(env.viewer, sessionId), /busy/);
    callback(null, { success: true, contents: Buffer.from('bad image') });
    await assert.rejects(request);
    assert.equal(env.service.sessions.size, 0);
});

test('failed startup and capture timeout release the session; disconnects notify both participants', async () => {
    for (const failType of ['start', 'frame']) {
        const env = fixture({ command: (input, callback) => callback(input.type === failType ? new Error('timeout') : null, { success: true }) });
        if (failType === 'start') await assert.rejects(env.start(), /connectionLost/);
        else { const { sessionId } = await env.start(); await assert.rejects(env.service.frame(env.viewer, sessionId), /connectionLost/); }
        assert.equal(env.service.sessions.size, 0);
    }
    const env = fixture(); await env.start(); env.service.stopForSocket(env.viewer.id);
    assert.equal(env.events.filter(event => event.event === 'station:live:ended').length, 2);
});

test('Socket.IO live handlers use status/payload envelopes, reject malformed input, and stop on disconnect', async () => {
    const env = fixture();
    const handlers = {};
    env.viewer.on = (event, handler) => { handlers[event] = handler; };
    const context = { module: { exports: {} }, require: () => ({ getStationLive: () => env.service }) };
    require('node:vm').runInNewContext(require('node:fs').readFileSync(require.resolve('../socket/event/stationLive'), 'utf8'), context);
    context.module.exports(env.viewer, env.io);
    const call = (event, data) => new Promise(resolve => handlers[event](data, resolve));
    assert.equal((await call('station:live:start', { _id: 'invalid' })).status, 'error');
    const started = await call('station:live:start', { _id: env.station._id, frameProtocol: 2 });
    assert.equal(started.status, 'success');
    assert.equal(env.service.sessions.get(started.payload.sessionId).optimized, true);
    const frame = await call('station:live:frame', started.payload);
    assert.equal(frame.status, 'success');
    assert.ok(frame.payload.contents.equals(jpeg));
    assert.equal((await call('station:live:action', { ...started.payload, type: 'clear' })).status, 'success');
    handlers.disconnect();
    assert.equal(env.service.sessions.size, 0);
});

test('optimized frames omit unchanged bytes, back off when idle, and enforce pacing before capture', async () => {
    let revision, changed = false;
    const nextImage = require('canvas').createCanvas(800, 600).toBuffer('image/jpeg');
    const env = fixture({ command: (input, callback) => callback(null, input.type === 'start'
        ? { success: true, frameProtocol: 2 }
        : changed ? { success: true, contents: nextImage }
            : revision ? { success: true, unchanged: true, revision } : { success: true, contents: jpeg }) });
    const { sessionId } = await env.start({ frameProtocol: 2 });
    const first = await env.service.frame(env.viewer, sessionId);
    assert.ok(first.contents.equals(jpeg)); revision = first.revision;
    assert.equal(first.nextPollMs, 500);
    const calls = env.commands.length;
    await assert.rejects(env.service.frame(env.viewer, sessionId), /busy/);
    assert.equal(env.commands.length, calls);
    env.advance(first.nextPollMs);
    const second = await env.service.frame(env.viewer, sessionId);
    assert.equal(second.unchanged, true); assert.equal(second.contents, undefined); assert.equal(second.nextPollMs, 1000);
    assert.equal(env.commands.at(-1).previousRevision, revision);
    env.advance(second.nextPollMs);
    const third = await env.service.frame(env.viewer, sessionId);
    assert.equal(third.nextPollMs, 2000);
    assert.equal(env.counts.decodes, 1);
    assert.equal(env.counts.authorizations, 9); // Start plus pre/post checks for every response, including unchanged ones.
    changed = true; env.advance(third.nextPollMs);
    const fourth = await env.service.frame(env.viewer, sessionId);
    assert.ok(fourth.contents.equals(nextImage)); assert.notEqual(fourth.revision, revision);
    assert.equal(fourth.nextPollMs, 500); assert.equal(fourth.width, 800); assert.equal(env.counts.decodes, 2);
});

test('legacy stations still work; duplicate full frames avoid another decode and viewer transfer', async () => {
    const env = fixture();
    const { sessionId } = await env.start({ frameProtocol: 2 });
    const first = await env.service.frame(env.viewer, sessionId); env.advance(first.nextPollMs);
    const second = await env.service.frame(env.viewer, sessionId);
    assert.equal(second.unchanged, true); assert.equal(second.contents, undefined); assert.equal(env.counts.decodes, 1);
    assert.equal(env.commands.at(-1).frameProtocol, undefined);
    const legacy = fixture(); const old = await legacy.start();
    await legacy.service.frame(legacy.viewer, old.sessionId); legacy.advance(250);
    assert.ok((await legacy.service.frame(legacy.viewer, old.sessionId)).contents);
});

test('unvalidated or mismatched unchanged frames fail, and privacy is checked after an unchanged response', async () => {
    for (const mode of ['first', 'wrongRevision', 'privacy']) {
        const env = fixture({ command: (input, callback) => {
            if (input.type === 'start') return callback(null, { success: true, frameProtocol: 2 });
            if (mode !== 'first' && !input.previousRevision) return callback(null, { success: true, contents: jpeg });
            if (mode === 'privacy') env.station.screenshotsEnabled = false;
            callback(null, { success: true, unchanged: true, revision: mode === 'wrongRevision' ? 'wrong' : input.previousRevision });
        } });
        const { sessionId } = await env.start({ frameProtocol: 2 });
        if (mode !== 'first') { const first = await env.service.frame(env.viewer, sessionId); env.advance(first.nextPollMs); }
        await assert.rejects(env.service.frame(env.viewer, sessionId), mode === 'privacy' ? /privacyChanged/ : /invalidFrame/);
        assert.equal(env.service.sessions.size, 0);
    }
});

test('large frames are paced by bytes and recent validation avoids redundant sweep reads', async () => {
    // Valid JPEG with permitted trailing data exercises a large payload without an oversized decode.
    const large = Buffer.concat([jpeg, Buffer.alloc(1024 * 1024)]);
    const env = fixture({ command: (input, callback) => callback(null, input.type === 'start'
        ? { success: true } : { success: true, contents: large }) });
    const { sessionId } = await env.start({ frameProtocol: 2 });
    const frame = await env.service.frame(env.viewer, sessionId);
    assert.equal(frame.nextPollMs, Math.ceil(large.length / (512 * 1024) * 1000));
    const reads = env.counts.reads;
    await env.service.sweep(); assert.equal(env.counts.reads, reads);
    env.advance(1000); await env.service.sweep(); assert.equal(env.counts.reads, reads + 1);
    env.station.screenshotsEnabled = false;
    await env.service.changed(env.station._id); // Explicit changes never use the sweep freshness shortcut.
    assert.equal(env.service.sessions.size, 0);
});
