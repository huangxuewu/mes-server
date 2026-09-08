const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');

const INTERVAL = 5 * 60 * 1000;
const MAX_BYTES = 5 * 1024 * 1024;
const services = new WeakMap();
const generation = station => station.screenshotGeneration || 0;
const identity = station => ({ _id: String(station._id), stationId: station.stationId });
const storagePath = (station, mime = station.screenshot?.mime || 'image/jpeg') =>
    `/DH MES/station-screenshots/${station._id}/${station.stationId}/latest.${mime === 'image/webp' ? 'webp' : 'jpg'}`;
const imageMime = contents => contents?.subarray(0, 4).toString() === 'RIFF' && contents.subarray(8, 12).toString() === 'WEBP'
    ? 'image/webp' : 'image/jpeg';
const generationFilter = station => station.screenshotGeneration === undefined
    ? { screenshotGeneration: { $exists: false } } : { screenshotGeneration: station.screenshotGeneration };

const validateImage = async (contents, { allowWebp = false } = {}) => {
    if (!Buffer.isBuffer(contents) || !contents.length || contents.length > MAX_BYTES) throw new Error('Invalid screenshot image');
    if (imageMime(contents) === 'image/webp') {
        if (!allowWebp || contents.length < 20 || contents.readUInt32LE(4) + 8 !== contents.length) throw new Error('Invalid screenshot image');
        const image = require('sharp')(contents, { limitInputPixels: 1920 * 1920, failOn: 'warning' });
        const metadata = await image.metadata();
        if (metadata.format !== 'webp' || !metadata.width || !metadata.height || Math.max(metadata.width, metadata.height) > 1920
            || (metadata.pages || 1) !== 1 || metadata.loop !== undefined) throw new Error('Invalid screenshot dimensions');
        await image.timeout({ seconds: 5 }).raw().toBuffer();
        return { width: metadata.width, height: metadata.height };
    }
    if (contents[0] !== 0xff || contents[1] !== 0xd8) throw new Error('Invalid screenshot image');
    // Check the JPEG frame before decoding, to bound decoded memory as well as upload size.
    let offset = 2, width = 0, height = 0;
    while (offset + 4 <= contents.length) {
        if (contents[offset++] !== 0xff) break;
        while (contents[offset] === 0xff) offset++;
        const marker = contents[offset++];
        if (marker === 0xda || marker === 0xd9) break;
        if (offset + 2 > contents.length) break;
        const length = contents.readUInt16BE(offset);
        if (length < 2 || offset + length > contents.length) break;
        if ([0xc0, 0xc1, 0xc2].includes(marker) && length >= 8) {
            height = contents.readUInt16BE(offset + 3);
            width = contents.readUInt16BE(offset + 5);
            break;
        }
        offset += length;
    }
    if (!width || !height || Math.max(width, height) > 1920) throw new Error('Invalid screenshot dimensions');
    const image = await require('canvas').loadImage(contents);
    if (image.width !== width || image.height !== height) throw new Error('Invalid screenshot image');
    return { width, height };
};

const createStationScreenshots = ({ io, db, getDropbox, authorize, cacheDir = path.join(os.tmpdir(), 'mes-station-screenshots'), now = Date.now }) => {
    const states = new Map();
    const downloads = new Map();
    let timer;
    let cleanupTimer;
    const stateFor = id => {
        const key = String(id);
        if (!states.has(key)) states.set(key, { busy: false, error: '', lastAttempt: 0, connectionId: null });
        return states.get(key);
    };
    const cachePath = (station, revision) => path.join(cacheDir, `${station._id}-${station.stationId}-${createHash('sha256').update(revision).digest('hex')}.jpg`);
    const targetFor = station => [...io.sockets.sockets.values()]
        .filter(socket => socket.connected && socket.data.stationPresence?._id === String(station._id)
            && socket.data.stationPresence.stationId === station.stationId)
        .sort((a, b) => b.data.stationPresence.at - a.data.stationPresence.at)[0];
    const project = station => {
        const state = stateFor(station._id);
        const target = targetFor(station);
        return {
            screenshotsEnabled: station.screenshotsEnabled !== false,
            screenshotGeneration: generation(station),
            screenshot: station.screenshotsEnabled !== false && station.screenshot?.revision && station.screenshot.stationId === station.stationId
                ? { revision: station.screenshot.revision, capturedAt: station.screenshot.capturedAt,
                    width: station.screenshot.width, height: station.screenshot.height, size: station.screenshot.size,
                    mime: station.screenshot.mime || 'image/jpeg' } : null,
            screenshotSupported: target ? target.data.screenshotSupported === true : station.screenshotSupported === true,
            screenshotCapturing: state.busy && station.screenshotsEnabled !== false,
            screenshotError: station.screenshotsEnabled !== false ? state.error : '',
        };
    };
    const notify = async id => {
        const station = await db.station.findById(id).lean();
        if (!station) return;
        const payload = { _id: String(id), ...project(station) };
        await Promise.allSettled([...io.sockets.sockets.values()].map(async socket => {
            if (!socket.connected || !Number.isInteger(socket.data.screenshotViewer) || socket.data.screenshotViewer !== socket.data.sessionGeneration) return;
            await authorize(socket);
            socket.emit('station:screenshot:changed', payload);
        }));
    };
    const assertCurrent = async (original, target) => {
        const station = await db.station.findById(original._id).lean();
        if (!station || station.stationId !== original.stationId || station.screenshotsEnabled === false
            || generation(station) !== generation(original)) throw new Error('Screenshot settings changed');
        if (target && (!target.connected || targetFor(station) !== target)) throw new Error('Station connection changed');
        return station;
    };
    const storage = async signal => {
        const dropbox = await getDropbox({ signal });
        if (!dropbox) throw new Error('Screenshot storage is not configured');
        return dropbox;
    };
    const storeCache = async (station, revision, contents) => {
        await fs.mkdir(cacheDir, { recursive: true });
        await fs.writeFile(cachePath(station, revision), contents, { mode: 0o600 });
    };
    const capture = async id => {
        const state = stateFor(id);
        if (state.busy) throw new Error('A screenshot capture is already in progress');
        state.busy = true;
        state.error = '';
        state.lastAttempt = now();
        try {
            const station = await db.station.findById(id).lean();
            if (!station?.stationId) throw new Error('Station is not linked');
            if (station.screenshotsEnabled === false) throw new Error('Station screenshots are disabled');
            const target = targetFor(station);
            if (!target) throw new Error('Station is offline');
            if (!target.data.screenshotSupported) throw new Error('Client update required');
            const signal = AbortSignal.timeout(45000);
            const dropbox = await storage(signal);
            await assertCurrent(station, target);
            state.connectionId = target.id;
            void notify(id).catch(() => {});
            const response = await new Promise((resolve, reject) => {
                target.timeout(15000).emit('station:screenshot:capture', { ...identity(station), generation: generation(station), format: 'webp' }, (error, result) => {
                    if (error) return reject(new Error('Station screenshot timed out'));
                    resolve(result);
                });
            });
            if (!response?.success) throw new Error(response?.error || 'Station capture failed');
            const contents = Buffer.isBuffer(response.contents) ? response.contents
                : response.contents instanceof Uint8Array ? Buffer.from(response.contents) : null;
            const dimensions = await validateImage(contents, { allowWebp: true });
            const mime = imageMime(contents);
            await assertCurrent(station, target);
            const capturedAt = new Date(now());
            const folders = ['/DH MES', '/DH MES/station-screenshots', `/DH MES/station-screenshots/${station._id}`,
                `/DH MES/station-screenshots/${station._id}/${station.stationId}`];
            for (const folder of folders) {
                try { await dropbox.filesCreateFolderV2({ path: folder, autorename: false }, { signal }); }
                catch (error) { if (!String(error?.error?.error_summary || '').startsWith('path/conflict/folder')) throw error; }
            }
            await assertCurrent(station, target);
            const uploaded = await dropbox.filesUpload({ path: storagePath(station, mime), contents, mode: { '.tag': 'overwrite' }, autorename: false, mute: true }, { signal });
            await assertCurrent(station, target);
            const screenshot = { stationId: station.stationId, revision: uploaded.result.rev, capturedAt, ...dimensions, size: contents.length, mime };
            const saved = await db.station.findOneAndUpdate({ ...identity(station), screenshotsEnabled: { $ne: false }, ...generationFilter(station) },
                { $set: { screenshot } }, { new: true }).lean();
            if (!saved) throw new Error('Screenshot settings changed');
            await storeCache(station, screenshot.revision, contents).catch(() => {});
            if (station.screenshot?.revision && station.screenshot.revision !== screenshot.revision)
                await fs.unlink(cachePath(station, station.screenshot.revision)).catch(() => {});
            // Only remove the alternate format after publication succeeds. Retry on
            // each successful capture if Dropbox was temporarily unavailable.
            await dropbox.filesDeleteV2({ path: storagePath(station, mime === 'image/webp' ? 'image/jpeg' : 'image/webp') },
                { signal: AbortSignal.timeout(5000) }).catch(() => {});
            return project(saved);
        } catch (error) {
            state.error = String(error.message || 'Screenshot capture failed').slice(0, 500);
            throw error;
        } finally {
            state.busy = false;
            void notify(id).catch(() => {});
        }
    };
    const read = async (id, socket) => {
        const session = socket.data.sessionGeneration;
        await authorize(socket);
        const station = await db.station.findById(id).lean();
        if (!station?.stationId || station.screenshotsEnabled === false) throw new Error('Station screenshots are disabled');
        if (!station.screenshot?.revision || station.screenshot.stationId !== station.stationId) throw new Error('No screenshot available');
        const revision = station.screenshot.revision;
        const file = cachePath(station, revision);
        let contents;
        try { contents = await fs.readFile(file); }
        catch {
            if (!downloads.has(file)) downloads.set(file, (async () => {
                const signal = AbortSignal.timeout(30000);
                const dropbox = await storage(signal);
                await assertCurrent(station);
                const result = await dropbox.filesDownload({ path: storagePath(station), rev: revision }, { signal });
                const bytes = Buffer.from(result.result.fileBinary);
                await validateImage(bytes, { allowWebp: true });
                if (imageMime(bytes) !== (station.screenshot.mime || 'image/jpeg')) throw new Error('Screenshot format changed');
                await storeCache(station, revision, bytes).catch(() => {});
                return bytes;
            })().finally(() => downloads.delete(file)));
            contents = await downloads.get(file);
        }
        await authorize(socket);
        const current = await assertCurrent(station);
        if (session !== socket.data.sessionGeneration || !socket.connected || current.screenshot?.revision !== revision)
            throw new Error('Screenshot request changed');
        return { ...project(current), contents, mime: current.screenshot.mime || 'image/jpeg' };
    };
    const schedule = async () => {
        const ids = [...new Set([...io.sockets.sockets.values()]
            .filter(socket => socket.connected && socket.data.screenshotSupported && socket.data.stationPresence)
            .map(socket => socket.data.stationPresence._id))];
        for (const id of ids) {
            if (require('./stationLive').isStationLive(io, id)) continue;
            const state = stateFor(id);
            if (state.busy) continue;
            const station = await db.station.findById(id).lean();
            if (!station || station.screenshotsEnabled === false) continue;
            const target = targetFor(station);
            if (!target?.data.screenshotSupported) continue;
            if (state.connectionId === target.id && now() - state.lastAttempt < INTERVAL) continue;
            state.connectionId = target.id;
            void capture(id).catch(() => {});
        }
    };
    const changed = async id => {
        stateFor(id).lastAttempt = 0;
        stateFor(id).error = '';
        await notify(id);
        await schedule();
    };
    const cleanup = async () => {
        const stations = await db.station.find({ 'screenshotCleanup.0': { $exists: true } }).limit(20).lean();
        for (const station of stations) {
            if (stateFor(station._id).busy) continue;
            for (const oldId of station.screenshotCleanup) {
                if (oldId === station.stationId) continue;
                const signal = AbortSignal.timeout(30000);
                try {
                    const dropbox = await storage(signal);
                    await dropbox.filesDeleteV2({ path: `/DH MES/station-screenshots/${station._id}/${oldId}` }, { signal });
                }
                catch (error) { if (!String(error?.error?.error_summary || '').includes('not_found')) continue; }
                const files = await fs.readdir(cacheDir).catch(() => []);
                for (const file of files.filter(file => file.startsWith(`${station._id}-${oldId}-`)))
                    await fs.unlink(path.join(cacheDir, file)).catch(() => {});
                await db.station.updateOne({ _id: station._id }, { $pull: { screenshotCleanup: oldId } });
            }
        }
        const cached = (await fs.readdir(cacheDir).catch(() => []))
            .filter(file => /^[a-f\d]{24}-[a-f\d-]{36}-[a-f\d]{64}\.jpg$/i.test(file));
        for (const id of new Set(cached.map(file => file.slice(0, 24)))) {
            if (stateFor(id).busy) continue;
            const station = await db.station.findById(id).lean();
            const retained = station?.screenshot?.revision && station.screenshot.stationId === station.stationId
                ? path.basename(cachePath(station, station.screenshot.revision)) : null;
            for (const file of cached.filter(file => file.startsWith(`${id}-`) && file !== retained))
                await fs.unlink(path.join(cacheDir, file)).catch(() => {});
        }
    };
    let running = false;
    let cleaning = false;
    const start = () => {
        if (timer) return;
        timer = setInterval(async () => {
            if (running) return;
            running = true;
            try { await schedule(); }
            catch (error) { console.error('[Station screenshots]', error.message); }
            finally { running = false; }
        }, 10000);
        timer.unref?.();
        cleanupTimer = setInterval(async () => {
            if (cleaning) return;
            cleaning = true;
            try { await cleanup(); }
            catch (error) { console.error('[Station screenshot cleanup]', error.message); }
            finally { cleaning = false; }
        }, 60000);
        cleanupTimer.unref?.();
    };
    return { capture, read, project, notify, changed, schedule, cleanup, start, stop: () => {
        clearInterval(timer); clearInterval(cleanupTimer); timer = null; cleanupTimer = null;
    } };
};

const getStationScreenshots = io => {
    if (!services.has(io)) services.set(io, createStationScreenshots({ io, db: require('../models'),
        getDropbox: require('./documentStorage').getConfiguredDropbox,
        authorize: async socket => {
            const { getActiveSessionUser, hasPermission } = require('../socket/session');
            if (!hasPermission(await getActiveSessionUser(socket), 'access', 'configuration.page.access')) throw new Error('Access denied');
        },
    }));
    return services.get(io);
};

module.exports = { getStationScreenshots, createStationScreenshots, validateImage };
