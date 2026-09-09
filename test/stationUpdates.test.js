const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { Readable } = require('node:stream');
const { createHash } = require('node:crypto');

const fixture = async (t, options = {}) => {
    const bytes = Buffer.from('MES installer test bytes');
    const manifest = { version: '26.3319.1', files: [{ url: 'MES-26.3319.1.exe', size: bytes.length,
        sha512: createHash('sha512').update(bytes).digest('base64') }] };
    manifest.sha512 = manifest.files[0].sha512;
    const calls = [];
    const paths = ['axios', '../utils/stationRelease', '../routes/stationUpdates'].map(require.resolve);
    const previous = paths.map(path => require.cache[path]);
    require.cache[paths[0]] = { exports: { get: async (url, request) => {
        calls.push({ url, request });
        if (options.fail) throw new Error('Upstream unavailable');
        return { data: Readable.from([options.corrupt ? Buffer.from('invalid') : bytes]) };
    } } };
    require.cache[paths[1]] = { exports: { RELEASE_BASE: 'https://github.com/huangxuewu/mes-release/releases',
        getReleaseManifest: async version => {
            assert.ok(['latest', manifest.version].includes(version));
            return manifest;
        } } };
    delete require.cache[paths[2]];
    const app = express();
    try { app.use('/station-updates', require(paths[2])); }
    finally { paths.forEach((path, i) => previous[i] ? require.cache[path] = previous[i] : delete require.cache[path]); }
    const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    return { calls, bytes, manifest, url: `http://127.0.0.1:${server.address().port}/station-updates` };
};

test('relay metadata pins installer links to the same server and preserves the upstream checksum', async t => {
    const env = await fixture(t);
    const response = await fetch(`${env.url}/latest/latest.yml`);
    const metadata = await response.json();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(metadata.files[0].url, '../26.3319.1/MES-26.3319.1.exe');
    assert.equal(metadata.files[0].sha512, env.manifest.sha512);
    assert.equal(env.calls.length, 0);
});

test('relay streams the installer itself without redirecting the station back to GitHub', async t => {
    const env = await fixture(t);
    const response = await fetch(`${env.url}/26.3319.1/MES-26.3319.1.exe`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('location'), null);
    assert.ok(Buffer.from(await response.arrayBuffer()).equals(env.bytes));
    assert.equal(env.calls[0].url, 'https://github.com/huangxuewu/mes-release/releases/download/v26.3319.1/MES-26.3319.1.exe');
    assert.equal(env.calls[0].request.responseType, 'stream');
});

test('relay rejects arbitrary files and upstream URLs without making a download request', async t => {
    const env = await fixture(t);
    for (const suffix of ['bad/latest.yml', '26.3319.1/other.exe', '26.3319.1/https%3A%2F%2Fevil.invalid%2Fbad.exe',
        '26.3319.1/%2e%2e%2fprivate.exe']) {
        assert.equal((await fetch(`${env.url}/${suffix}`)).status, 404);
    }
    assert.equal(env.calls.length, 0);
});

test('relay download failures are explicit and corrupt installer bytes cannot finish successfully', async t => {
    const failed = await fixture(t, { fail: true });
    assert.equal((await fetch(`${failed.url}/26.3319.1/MES-26.3319.1.exe`)).status, 502);
    const corrupt = await fixture(t, { corrupt: true });
    await assert.rejects(async () => {
        const response = await fetch(`${corrupt.url}/26.3319.1/MES-26.3319.1.exe`);
        await response.arrayBuffer();
    });
});
