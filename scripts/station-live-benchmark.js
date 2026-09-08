// Offline payload benchmark: real live service/JPEG validator, synthetic desktops,
// simulated clock and station connection. No MongoDB, Dropbox, or network access.
const { createCanvas } = require('canvas');
const { createHash } = require('node:crypto');
const { createStationLive } = require('../utils/stationLive');
const { validateImage } = require('../utils/stationScreenshots');

const desktop = (edge, quality, step) => {
    const canvas = createCanvas(edge, Math.round(edge * 9 / 16));
    const context = canvas.getContext('2d');
    context.scale(edge / 1920, edge / 1920);
    context.fillStyle = '#edf1f6'; context.fillRect(0, 0, 1920, 1080);
    context.fillStyle = '#183651'; context.fillRect(0, 0, 1920, 70);
    context.font = '24px sans-serif'; context.fillStyle = '#fff'; context.fillText('MES · Production overview', 32, 45);
    for (let row = 0; row < 22; row++) {
        context.fillStyle = row % 2 ? '#fff' : '#e5eaf0'; context.fillRect(24, 100 + row * 40, 1872, 40);
        context.fillStyle = '#22364b'; context.font = '18px sans-serif';
        context.fillText(`Station ${row + 1}     Order 1024-${row}     Line A     Completed ${row * 27 + step} / 1000`, 44, 126 + row * 40);
        context.fillStyle = '#21886a'; context.fillRect(1000, 111 + row * 40, 180 + (step % 8) * 24, 16);
    }
    return canvas.toBuffer('image/jpeg', { quality });
};

const run = async (workload, optimized) => {
    let clock = 0, captures = 0, uploaded = 0, downloaded = 0, decoded = 0, reads = 0, checks = 0;
    const images = Array.from({ length: 8 }, (_, step) => desktop(optimized ? 1600 : 1920, optimized ? .65 : .8, step));
    const station = { _id: '507f1f77bcf86cd799439011', stationId: 'target', status: 'Active', screenshotsEnabled: true };
    const viewer = { id: 'viewer', connected: true, data: {}, emit() {} };
    const target = { id: 'target', connected: true, data: { liveSupported: true,
        stationPresence: { _id: station._id, stationId: 'target', at: 1 } }, emit() {},
        timeout: () => ({ emit: (_event, command, callback) => {
            if (command.type === 'start') return callback(null, { success: true, frameProtocol: 2 });
            captures++;
            const step = workload === 'static' ? 0 : workload === 'occasional' ? Math.floor(clock / 5000) : captures;
            const contents = images[step % images.length];
            const revision = createHash('sha256').update(contents).digest('hex');
            const unchanged = command.frameProtocol === 2 && command.previousRevision === revision;
            if (!unchanged) uploaded += contents.length;
            callback(null, unchanged ? { success: true, unchanged, revision } : { success: true, contents });
        } }) };
    const service = createStationLive({ io: { sockets: { sockets: new Map([['viewer', viewer], ['target', target]]) } },
        db: { station: { findById: () => ({ lean: async () => { reads++; return station; } }) } },
        authorize: async () => { checks++; return {}; }, now: () => clock,
        validateImage: async contents => { decoded++; return validateImage(contents); } });
    const { sessionId } = await service.start(viewer, station._id, optimized ? { frameProtocol: 2 } : {});
    let nextSweep = 1000;
    while (clock < 60000) {
        const response = await service.frame(viewer, sessionId);
        downloaded += response.contents?.length || 0;
        const nextFrame = clock + (optimized ? response.nextPollMs : 250);
        while (nextSweep < nextFrame && nextSweep < 60000) {
            clock = nextSweep; await service.sweep(); nextSweep += 1000;
        }
        clock = nextFrame;
    }
    service.stop(viewer, sessionId);
    return { workload, mode: optimized ? 'optimized' : 'legacy wire mode', captures, decoded,
        uploadedBytes: uploaded, downloadedBytes: downloaded, stationReads: reads, authorizationChecks: checks };
};

(async () => {
    const results = [];
    for (const workload of ['static', 'occasional', 'continuous']) {
        const legacy = await run(workload, false), optimized = await run(workload, true);
        results.push({ workload, legacy, optimized,
            imagePayloadReductionPercent: +(100 * (1 - optimized.uploadedBytes / legacy.uploadedBytes)).toFixed(2) });
    }
    console.log(JSON.stringify({ durationSeconds: 60,
        limitations: 'Simulated zero-latency sessions; node-canvas JPEG fixtures, not Electron capture. Counts exclude control packets, TCP/TLS overhead and image generation CPU. Both modes use the current server safety checks.',
        results }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
