const express = require('express');
const axios = require('axios');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');
const { createHash } = require('node:crypto');
const { getReleaseManifest, RELEASE_BASE } = require('../utils/stationRelease');

const router = express.Router();
// This mirrors only published MES installers; callers cannot supply an upstream URL.
router.get('/:version/:file', async (request, response) => {
    const abort = new AbortController();
    response.on('close', () => abort.abort());
    try {
        const { version, file } = request.params;
        if (version !== 'latest' && !/^\d+\.\d+\.\d+$/.test(version)) return response.sendStatus(404);
        if (file !== 'latest.yml' && !/^[a-zA-Z0-9][a-zA-Z0-9 ._-]{0,180}\.exe$/.test(file)) return response.sendStatus(404);
        const manifest = await getReleaseManifest(version);
        if (abort.signal.aborted) return;
        if (file === 'latest.yml') {
            const installer = { ...manifest.files[0], url: `../${manifest.version}/${encodeURIComponent(manifest.files[0].url)}` };
            return response.set('Cache-Control', 'no-store').type('text/yaml')
                .send(JSON.stringify({ ...manifest, files: [installer], path: installer.url }));
        }
        if (file !== manifest.files[0].url) return response.sendStatus(404);
        const upstream = await axios.get(`${RELEASE_BASE}/download/v${manifest.version}/${encodeURIComponent(file)}`, {
            responseType: 'stream', timeout: 20000, signal: abort.signal,
            headers: { 'User-Agent': 'MES-Station-Updates' },
        });
        response.status(200).set({ 'Content-Type': 'application/octet-stream', 'Content-Length': String(manifest.files[0].size),
            'Cache-Control': 'public, max-age=3600', 'X-Content-Type-Options': 'nosniff' });
        // Stream bytes through the server, including GitHub redirects. electron-updater
        // verifies the original manifest's SHA-512 before it can run the installer.
        let bytes = 0;
        const checksum = createHash('sha512');
        const verify = new Transform({
            transform(chunk, _encoding, callback) {
                bytes += chunk.length;
                if (bytes > manifest.files[0].size) return callback(new Error('Release size mismatch'));
                checksum.update(chunk);
                callback(null, chunk);
            },
            flush(callback) {
                callback(bytes === manifest.files[0].size && checksum.digest('base64') === manifest.sha512
                    ? null : new Error('Release checksum mismatch'));
            },
        });
        await pipeline(upstream.data, verify, response);
    } catch (error) {
        if (abort.signal.aborted) return;
        console.error('[Station update relay]', error.message);
        response.headersSent ? response.destroy() : response.status(502).send('MES release download unavailable');
    }
});

module.exports = router;
