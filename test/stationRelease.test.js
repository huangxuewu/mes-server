const assert = require('node:assert/strict');
const test = require('node:test');
const { getStationUpdate } = require('../utils/stationRelease');

test('MES versions compare numerically with an inclusive remote deployment minimum', () => {
    const release = { version: '26.3318.1', error: '' };
    for (const [version, supported, available] of [
        ['26.3317.1989', false, true], ['26.3317.1990', true, true],
        ['v26.3317.1990', true, true], ['26.3317.9999', true, true],
        ['26.3318.1', true, false], ['26.3318.10', true, false], ['27.1.0', true, false],
        [undefined, null, false], ['', null, false], ['26.3317', null, false], ['invalid', null, false],
    ]) {
        const result = getStationUpdate(version, release);
        assert.equal(result.remoteDeploySupported, supported, version);
        assert.equal(result.available, available, version);
    }
});

const fixture = (t, get) => {
    const axiosPath = require.resolve('axios');
    const releasePath = require.resolve('../utils/stationRelease');
    const previousAxios = require.cache[axiosPath];
    const previousRelease = require.cache[releasePath];
    require.cache[axiosPath] = { id: axiosPath, filename: axiosPath, loaded: true, exports: { get } };
    delete require.cache[releasePath];
    const release = require(releasePath);
    t.after(() => {
        require.cache[axiosPath] = previousAxios;
        require.cache[releasePath] = previousRelease;
    });
    return release;
};

const manifest = JSON.stringify({ version: '26.3317.1990', files: [{ url: 'MES-26.3317.1990.exe',
    sha512: Buffer.alloc(64).toString('base64'), size: 100 }] });

test('release lookup uses the published updater manifest and shares concurrent and cached requests', async t => {
    let calls = 0;
    const release = fixture(t, async (url, options) => {
        calls++;
        assert.equal(url, 'https://github.com/huangxuewu/mes-release/releases/latest/download/latest.yml');
        assert.equal(options.timeout, 5000);
        return { data: manifest };
    });
    const results = await Promise.all([release.getLatestRelease(), release.getLatestRelease()]);
    assert.deepEqual(results[0], { version: '26.3317.1990', error: '' });
    assert.deepEqual(results[0], results[1]);
    await release.getLatestRelease();
    assert.equal(calls, 1);
});

test('failed or unusable GitHub releases disable updates', async t => {
    for (const data of [null, { tag_name: 'invalid' }, { tag_name: 'v27.1.0', assets: [] },
        { tag_name: 'v27.1.0', prerelease: true }, { tag_name: 'v27.1.0', draft: true }]) {
        await t.test(JSON.stringify(data), async t => {
            const release = fixture(t, async () => {
                if (!data) throw new Error('GitHub unavailable');
                return { data };
            });
            assert.deepEqual(await release.getLatestRelease(), { version: '', error: 'releaseUnavailable' });
        });
    }
});

test('deployment checks bypass cached latest versions and retain the last known version on failure', async t => {
    let latest = manifest;
    const release = fixture(t, async () => {
        if (!latest) throw new Error('GitHub unavailable');
        return { data: latest };
    });
    await release.getLatestRelease();
    latest = manifest.replaceAll('26.3317.1990', '26.3318.1');
    assert.equal((await release.getLatestRelease()).version, '26.3317.1990');
    assert.equal((await release.getLatestRelease({ force: true })).version, '26.3318.1');
    latest = null;
    const unavailable = await release.getLatestRelease({ force: true });
    assert.deepEqual(unavailable, { version: '26.3318.1', error: 'releaseUnavailable' });
    assert.equal(release.getStationUpdate('26.3317.1990', unavailable).available, false);
    assert.equal((await release.getReleaseManifest('26.3318.1')).files[0].url, 'MES-26.3318.1.exe');
});

test('version-specific feeds reject mismatches, untrusted URLs, malformed checksums and oversized installers', async t => {
    const original = JSON.parse(manifest);
    for (const info of [{ ...original, version: '1.0.0' },
        { ...original, files: [{ ...original.files[0], url: 'https://evil.invalid/MES.exe' }] },
        { ...original, files: [{ ...original.files[0], url: '../MES.exe' }] },
        { ...original, files: [{ ...original.files[0], sha512: 'invalid' }] },
        { ...original, files: [{ ...original.files[0], size: 2 ** 31 }] }]) {
        await t.test(JSON.stringify(info), async t => {
            const release = fixture(t, async () => ({ data: JSON.stringify(info) }));
            await assert.rejects(release.getReleaseManifest('26.3317.1990'), /Invalid release/);
        });
    }
});
