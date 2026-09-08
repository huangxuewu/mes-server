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

test('GitHub lookup uses the MES release repository and shares concurrent and cached requests', async t => {
    let calls = 0;
    const release = fixture(t, async (url, options) => {
        calls++;
        assert.equal(url, 'https://api.github.com/repos/huangxuewu/mes-release/releases/latest');
        assert.equal(options.timeout, 3000);
        return { data: { tag_name: 'v26.3317.1990', assets: [{ name: 'latest.yml' }, { name: 'MES.exe' }] } };
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
