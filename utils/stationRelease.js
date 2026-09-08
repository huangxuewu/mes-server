const axios = require('axios');

const REMOTE_DEPLOY_MINIMUM = '26.3317.1990';
const parseVersion = value => typeof value === 'string' && /^v?\d+\.\d+\.\d+$/.test(value)
    ? value.replace(/^v/, '').split('.').map(Number) : null;
const compareVersions = (left, right) => {
    const a = parseVersion(left);
    const b = parseVersion(right);
    if (!a || !b || ![...a, ...b].every(Number.isSafeInteger)) return null;
    for (let index = 0; index < a.length; index++) {
        if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
    }
    return 0;
};

let cached;
let expiresAt = 0;
let pending;
const getLatestRelease = async () => {
    if (cached && Date.now() < expiresAt) return cached;
    if (pending) return pending;
    pending = (async () => {
        try {
            const { data } = await axios.get('https://api.github.com/repos/huangxuewu/mes-release/releases/latest', {
                timeout: 3000,
                headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'MES-Station-Updates' },
            });
            if (data.draft || data.prerelease || compareVersions(data.tag_name, data.tag_name) !== 0)
                throw new Error('Invalid release version');
            if (!data.assets?.some(asset => asset.name === 'latest.yml') || !data.assets.some(asset => /\.exe$/i.test(asset.name)))
                throw new Error('Release installer is unavailable');
            cached = { version: data.tag_name.replace(/^v/, ''), error: '' };
            expiresAt = Date.now() + 60000;
        } catch {
            cached = { version: '', error: 'releaseUnavailable' };
            expiresAt = Date.now() + 15000;
        }
        return cached;
    })();
    try { return await pending; }
    finally { pending = null; }
};

const getStationUpdate = (version, release) => {
    const supported = compareVersions(version, REMOTE_DEPLOY_MINIMUM);
    return {
        latestVersion: release.version,
        remoteDeploySupported: supported === null ? null : supported >= 0,
        available: compareVersions(version, release.version) === -1,
        error: release.error,
    };
};

module.exports = { getLatestRelease, getStationUpdate };
