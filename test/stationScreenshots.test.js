const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createCanvas } = require('canvas');
const { createStationScreenshots, validateImage } = require('../utils/stationScreenshots');

const jpeg = createCanvas(640, 360).toBuffer('image/jpeg');
const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
};
const fixture = async (t, options = {}) => {
    const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mes-screenshot-test-'));
    t.after(() => fs.rm(cacheDir, { recursive: true, force: true }));
    const station = { _id: '507f1f77bcf86cd799439011', stationId: '123e4567-e89b-42d3-a456-426614174000', screenshotGeneration: 0, ...options.station };
    let clock = 1000000, captures = 0, uploads = 0, downloads = 0;
    const files = new Map();
    const commands = [];
    const storageCalls = [];
    const target = { id: 'station-socket', connected: true, data: { screenshotSupported: true,
        stationPresence: { _id: station._id, stationId: station.stationId, at: clock } },
        timeout: () => ({ emit: (event, payload, callback) => {
            captures++;
            commands.push({ event, payload });
            if (options.capture) return options.capture(callback);
            callback(null, { success: true, contents: jpeg });
        } }),
    };
    const events = [];
    const viewer = { connected: true, data: { sessionGeneration: 1, screenshotViewer: 1 }, emit: (event, payload) => events.push({ event, payload }) };
    const io = { sockets: { sockets: new Map([['station', target], ['viewer', viewer]]) } };
    const db = { station: {
        findById: () => ({ lean: async () => structuredClone(station) }),
        find: () => ({ limit: () => ({ lean: async () => station.screenshotCleanup?.length ? [structuredClone(station)] : [] }) }),
        updateOne: async (_filter, update) => { station.screenshotCleanup = station.screenshotCleanup.filter(id => id !== update.$pull.screenshotCleanup); },
        findOneAndUpdate: (filter, update) => ({ lean: async () => {
            if (options.beforeCommit) options.beforeCommit(station);
            if (filter.stationId !== station.stationId || station.screenshotsEnabled === false
                || (typeof filter.screenshotGeneration === 'number' && filter.screenshotGeneration !== station.screenshotGeneration)) return null;
            Object.assign(station, update.$set);
            return structuredClone(station);
        } }),
    } };
    const dropbox = {
        filesCreateFolderV2: async () => {},
        filesUpload: async ({ contents, path }) => {
            storageCalls.push({ type: 'upload', path });
            uploads++;
            if (options.upload) await options.upload();
            const rev = `rev-${uploads}`;
            files.set(rev, contents);
            return { result: { rev } };
        },
        filesDownload: async ({ rev, path }) => {
            storageCalls.push({ type: 'download', path });
            downloads++;
            if (options.download) await options.download();
            return { result: { fileBinary: files.get(rev) } };
        },
        filesDeleteV2: async ({ path }) => { storageCalls.push({ type: 'delete', path }); if (options.remove) await options.remove(); },
    };
    let allowed = true;
    const dependencies = { io, db, cacheDir, now: () => clock, getDropbox: () => options.noStorage ? null : dropbox,
        authorize: async () => { if (!allowed) throw new Error('Access denied'); } };
    const service = createStationScreenshots(dependencies);
    return { service, station, target, viewer, events, commands, cacheDir, dependencies, files, storageCalls,
        counts: () => ({ captures, uploads, downloads }), advance: value => { clock += value; }, deny: () => { allowed = false; } };
};

test('JPEG validation rejects malformed, oversized and excessive-resolution images', async () => {
    assert.deepEqual(await validateImage(jpeg), { width: 640, height: 360 });
    for (const bytes of [null, Buffer.from('fake'), Buffer.alloc(5 * 1024 * 1024 + 1), jpeg.subarray(0, 30), createCanvas(1921, 1).toBuffer('image/jpeg')])
        await assert.rejects(validateImage(bytes));
});

test('JPEG validation works when the optional canvas native binary is unavailable on the server', () => {
    const result = require('node:child_process').spawnSync(process.execPath, ['-e', `
        const assert = require('node:assert/strict');
        const Module = require('node:module');
        const originalLoad = Module._load;
        Module._load = function (id, ...args) {
            if (id === 'canvas') throw new Error("Cannot find module '../build/Release/canvas.node'");
            return originalLoad.call(this, id, ...args);
        };
        require('./utils/stationScreenshots').validateImage(Buffer.from(process.argv[1], 'base64'))
            .then(dimensions => assert.deepEqual(dimensions, { width: 640, height: 360 }))
            .catch(error => { console.error(error); process.exitCode = 1; });
    `, jpeg.toString('base64')], { cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
});

test('saved WebP validation checks bytes, resolution, complete decoding and rejects animation; Live remains JPEG-only', async () => {
    const sharp = require('sharp');
    const webp = await sharp(jpeg).webp().toBuffer();
    assert.deepEqual(await validateImage(webp, { allowWebp: true }), { width: 640, height: 360 });
    await assert.rejects(validateImage(webp));
    const animation = await sharp(Buffer.from([255, 0, 0, 0, 255, 0]), { raw: { width: 1, height: 2, channels: 3, pageHeight: 1 } })
        .webp({ loop: 0, delay: [100, 100] }).toBuffer();
    const oversized = await sharp({ create: { width: 1921, height: 1, channels: 3, background: '#fff' } }).webp().toBuffer();
    const corrupt = Buffer.from(webp); corrupt.fill(0, 20);
    for (const bytes of [webp.subarray(0, 20), corrupt, animation, oversized, Buffer.concat([webp, Buffer.from([1])])])
        await assert.rejects(validateImage(bytes, { allowWebp: true }));
});

test('WebP is stored and restored by MIME and extension while retained legacy JPEGs remain readable', async t => {
    const webp = await require('sharp')(jpeg).webp().toBuffer();
    let contents = webp;
    const env = await fixture(t, { capture: callback => callback(null, { success: true, contents, mime: 'image/jpeg' }) });
    await env.service.capture(env.station._id);
    assert.equal(env.commands[0].payload.format, 'webp');
    assert.equal(env.station.screenshot.mime, 'image/webp', 'detect bytes rather than trusting the client MIME');
    assert.ok(env.storageCalls.some(call => call.type === 'upload' && call.path.endsWith('/latest.webp')));
    assert.ok(env.storageCalls.some(call => call.type === 'delete' && call.path.endsWith('/latest.jpg')));
    await fs.rm(env.cacheDir, { recursive: true, force: true });
    const restarted = createStationScreenshots(env.dependencies);
    const restored = await restarted.read(env.station._id, env.viewer);
    assert.equal(restored.mime, 'image/webp'); assert.ok(restored.contents.equals(webp));
    assert.ok(env.storageCalls.some(call => call.type === 'download' && call.path.endsWith('/latest.webp')));
    env.station.screenshotsEnabled = false;
    await assert.rejects(restarted.read(env.station._id, env.viewer), /disabled/);
    env.station.screenshotsEnabled = true;
    contents = jpeg; await env.service.capture(env.station._id);
    delete env.station.screenshot.mime; // Metadata written by a previous backend version.
    await fs.rm(env.cacheDir, { recursive: true, force: true });
    assert.equal((await restarted.read(env.station._id, env.viewer)).mime, 'image/jpeg');
    assert.ok(env.storageCalls.some(call => call.type === 'delete' && call.path.endsWith('/latest.webp')));
});

test('failed WebP publication retains the prior JPEG and does not delete it', async t => {
    const webp = await require('sharp')(jpeg).webp().toBuffer();
    let contents = jpeg, fail = false;
    const env = await fixture(t, { capture: callback => callback(null, { success: true, contents }),
        upload: () => { if (fail) throw new Error('Dropbox unavailable'); } });
    await env.service.capture(env.station._id);
    const revision = env.station.screenshot.revision;
    env.storageCalls.length = 0; contents = webp; fail = true;
    await assert.rejects(env.service.capture(env.station._id), /Dropbox unavailable/);
    assert.equal(env.station.screenshot.revision, revision);
    assert.equal(env.storageCalls.some(call => call.type === 'delete'), false);
    assert.ok((await env.service.read(env.station._id, env.viewer)).contents.equals(jpeg));
});

test('privacy changes during Dropbox settings lookup prevent capture dispatch', async t => {
    const env = await fixture(t);
    const started = deferred();
    const ready = deferred();
    const service = createStationScreenshots({ ...env.dependencies, getDropbox: async () => {
        started.resolve();
        await ready.promise;
        return env.dependencies.getDropbox();
    } });
    const pending = service.capture(env.station._id);
    await started.promise;
    env.station.screenshotsEnabled = false;
    env.station.screenshotGeneration++;
    env.station.screenshotsEnabled = true;
    env.station.screenshotGeneration++;
    ready.resolve();
    await assert.rejects(pending, /Screenshot settings changed/);
    assert.equal(env.counts().captures, 0);
    assert.equal(env.counts().uploads, 0);
});

test('enabled defaults and initial, five-minute, reconnect and manual captures share one operation', async t => {
    const env = await fixture(t);
    assert.equal(env.service.project(env.station).screenshotsEnabled, true);
    assert.equal(env.service.project({ ...env.station, stationId: undefined }).screenshot, null);
    await env.service.schedule();
    while (env.service.project(env.station).screenshotCapturing) await flush();
    assert.equal(env.counts().captures, 1);
    env.advance(299999);
    await env.service.schedule();
    assert.equal(env.counts().captures, 1);
    env.advance(1);
    await env.service.schedule();
    while (env.service.project(env.station).screenshotCapturing) await flush();
    assert.equal(env.counts().captures, 2);
    env.target.id = 'reconnected';
    await env.service.schedule();
    while (env.service.project(env.station).screenshotCapturing) await flush();
    assert.equal(env.counts().captures, 3);
    await env.service.capture(env.station._id);
    assert.equal(env.counts().captures, 4);
    assert.equal(env.station.screenshot.revision, 'rev-4');
    assert.equal((await fs.readdir(env.cacheDir)).length, 1);
    assert.equal(env.commands[0].payload.generation, 0);
});

test('disabled stations retain the image while blocking capture, scheduling and direct retrieval', async t => {
    const env = await fixture(t);
    await env.service.capture(env.station._id);
    const saved = structuredClone(env.station.screenshot);
    env.station.screenshotsEnabled = false;
    env.station.screenshotGeneration++;
    await env.service.changed(env.station._id);
    assert.equal(env.events.at(-1).payload.screenshot, null);
    await assert.rejects(env.service.capture(env.station._id), /disabled/);
    await assert.rejects(env.service.read(env.station._id, env.viewer), /disabled/);
    assert.deepEqual(env.station.screenshot, saved);
    assert.equal((await fs.readdir(env.cacheDir)).length, 1);
    assert.equal(env.counts().captures, 1);
    env.station.screenshotsEnabled = true;
    env.station.screenshotGeneration++;
    assert.equal((await env.service.read(env.station._id, env.viewer)).screenshot.revision, saved.revision);
    await env.service.changed(env.station._id);
    while (env.service.project(env.station).screenshotCapturing) await flush();
    assert.equal(env.counts().captures, 2);
});

test('ending Live refreshes the saved image immediately without waiting for the five-minute interval', async t => {
    const env = await fixture(t);
    await env.service.capture(env.station._id);
    env.advance(1000);
    await env.service.refreshAfterLive({ _id: env.station._id, stationId: env.station.stationId, generation: 0 });
    while (env.service.project(env.station).screenshotCapturing) await flush();
    assert.equal(env.counts().captures, 2);
    assert.equal(env.station.screenshot.revision, 'rev-2');
    assert.equal(+env.station.screenshot.capturedAt, 1001000);
    assert.ok((await env.service.read(env.station._id, env.viewer)).contents.equals(jpeg));
    await env.service.schedule();
    assert.equal(env.counts().captures, 2);
});

test('Live refresh coalesces during an existing upload and captures afterward', async t => {
    const upload = deferred();
    const env = await fixture(t, { upload: () => upload.promise });
    const pending = env.service.capture(env.station._id);
    while (!env.counts().uploads) await flush();
    const request = { _id: env.station._id, stationId: env.station.stationId, generation: 0 };
    await env.service.refreshAfterLive(request);
    await env.service.refreshAfterLive(request);
    assert.equal(env.counts().captures, 1);
    upload.resolve();
    await pending;
    await flush();
    while (env.service.project(env.station).screenshotCapturing) await flush();
    assert.equal(env.counts().captures, 2);
    assert.equal(env.station.screenshot.revision, 'rev-2');
});

test('Live refresh respects privacy and identity, and waits for an offline station to reconnect', async t => {
    for (const change of [env => { env.station.screenshotsEnabled = false; }, env => { env.station.screenshotGeneration += 2; },
        env => { env.station.stationId = 'replacement'; }, env => { env.station.status = 'Disabled'; },
        env => { env.target.data.screenshotSupported = false; }]) {
        const env = await fixture(t);
        await env.service.capture(env.station._id);
        const request = { _id: env.station._id, stationId: env.station.stationId, generation: 0 };
        change(env);
        await env.service.refreshAfterLive(request);
        assert.equal(env.counts().captures, 1);
        assert.equal(env.station.screenshot.revision, 'rev-1');
    }
    const env = await fixture(t);
    await env.service.capture(env.station._id);
    env.target.connected = false;
    await env.service.refreshAfterLive({ _id: env.station._id, stationId: env.station.stationId, generation: 0 });
    assert.equal(env.counts().captures, 1);
    env.target.connected = true;
    await env.service.schedule();
    while (env.service.project(env.station).screenshotCapturing) await flush();
    assert.equal(env.station.screenshot.revision, 'rev-2');
});

test('concurrent captures do not duplicate dispatch; disabling during capture discards bytes', async t => {
    let respond;
    const env = await fixture(t, { capture: callback => { respond = callback; } });
    const pending = env.service.capture(env.station._id);
    while (!respond) await flush();
    await assert.rejects(env.service.capture(env.station._id), /already/);
    env.station.screenshotsEnabled = false;
    env.station.screenshotGeneration++;
    respond(null, { success: true, contents: jpeg });
    await assert.rejects(pending, /settings changed/);
    assert.equal(env.counts().uploads, 0);
});

test('disable and re-enable during Dropbox upload cannot publish the old operation', async t => {
    const wait = deferred();
    const env = await fixture(t, { upload: () => wait.promise });
    const pending = env.service.capture(env.station._id);
    while (!env.counts().uploads) await flush();
    env.station.screenshotGeneration += 2;
    wait.resolve();
    await assert.rejects(pending, /settings changed/);
    assert.equal(env.station.screenshot, undefined);
});

test('conditional metadata commit rejects a settings change after upload validation', async t => {
    const env = await fixture(t, { beforeCommit: station => { station.screenshotsEnabled = false; station.screenshotGeneration++; } });
    await assert.rejects(env.service.capture(env.station._id), /settings changed/);
    assert.equal(env.station.screenshot, undefined);
});

test('cache loss and backend restart restore an offline screenshot from the published Dropbox revision', async t => {
    const env = await fixture(t);
    await env.service.capture(env.station._id);
    for (const file of await fs.readdir(env.cacheDir)) await fs.unlink(path.join(env.cacheDir, file));
    env.target.connected = false;
    const restarted = createStationScreenshots(env.dependencies);
    const result = await restarted.read(env.station._id, env.viewer);
    assert.deepEqual(result.contents, jpeg);
    assert.equal(env.counts().downloads, 1);
    await restarted.read(env.station._id, env.viewer);
    assert.equal(env.counts().downloads, 1);
});

test('disable, identity replacement and lost permission during retrieval prevent image delivery', async t => {
    for (const change of [env => { env.station.screenshotsEnabled = false; }, env => { env.station.screenshotGeneration += 2; },
        env => { env.station.stationId = 'replacement'; }, env => env.deny(), env => { env.viewer.data.sessionGeneration++; }]) {
        const wait = deferred();
        const env = await fixture(t, { download: () => wait.promise });
        await env.service.capture(env.station._id);
        for (const file of await fs.readdir(env.cacheDir)) await fs.unlink(path.join(env.cacheDir, file));
        const pending = env.service.read(env.station._id, env.viewer);
        while (!env.counts().downloads) await flush();
        change(env);
        wait.resolve();
        await assert.rejects(pending);
    }
});

test('offline, unsupported, storage failure, capture error and timeout do not publish images', async t => {
    for (const options of [{ noStorage: true }, { capture: callback => callback(new Error('timeout')) },
        { capture: callback => callback(null, { success: false, error: 'Capture failed' }) }, { upload: async () => { throw new Error('Dropbox unavailable'); } }]) {
        const env = await fixture(t, options);
        await assert.rejects(env.service.capture(env.station._id));
        assert.equal(env.station.screenshot, undefined);
        assert.ok(env.service.project(env.station).screenshotError);
    }
    const env = await fixture(t);
    env.target.connected = false;
    await assert.rejects(env.service.capture(env.station._id), /offline/);
    env.target.connected = true;
    env.target.data.screenshotSupported = false;
    await assert.rejects(env.service.capture(env.station._id), /update required/);
});

test('disconnecting or replacing the source during capture rejects its image', async t => {
    let respond;
    const env = await fixture(t, { capture: callback => { respond = callback; } });
    const pending = env.service.capture(env.station._id);
    while (!respond) await flush();
    env.target.connected = false;
    respond(null, { success: true, contents: jpeg });
    await assert.rejects(pending, /connection changed/);
});

test('obsolete identity cleanup retries Dropbox failures and preserves the current identity', async t => {
    let failed = true;
    const env = await fixture(t, { remove: async () => { if (failed) throw new Error('unavailable'); } });
    env.station.screenshotCleanup = ['old-identity', env.station.stationId];
    await env.service.cleanup();
    assert.equal(env.station.screenshotCleanup.length, 2);
    failed = false;
    await env.service.cleanup();
    assert.deepEqual(env.station.screenshotCleanup, [env.station.stationId]);
});
