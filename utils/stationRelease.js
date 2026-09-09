const axios = require('axios');
const { load, JSON_SCHEMA } = require('js-yaml');

const RELEASE_BASE = 'https://github.com/huangxuewu/mes-release/releases';
const manifests = new Map();
const requests = new Map();
const getReleaseManifest = async (version = 'latest', { force = false } = {}) => {
    if (version !== 'latest' && !/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid release version');
    const cached = manifests.get(version);
    if (cached && (!force || version !== 'latest') && (version !== 'latest' || cached.expiresAt > Date.now())) return cached.manifest;
    if (requests.has(version)) return requests.get(version);
    const request = (async () => {
        const url = version === 'latest' ? `${RELEASE_BASE}/latest/download/latest.yml` : `${RELEASE_BASE}/download/v${version}/latest.yml`;
        const { data } = await axios.get(url, { timeout: 5000, maxContentLength: 256 * 1024, responseType: 'text',
            headers: { 'User-Agent': 'MES-Station-Updates', 'Cache-Control': 'no-cache' } });
        const info = load(data, { schema: JSON_SCHEMA });
        if (!info || typeof info.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(info.version)
            || compareVersions(info.version, info.version) !== 0 || (version !== 'latest' && info.version !== version))
            throw new Error('Invalid release version');
        const file = info.files?.find(file => typeof file?.url === 'string' && file.url.endsWith('.exe'));
        if (!file || !/^[a-zA-Z0-9][a-zA-Z0-9 ._-]{0,180}\.exe$/.test(file.url)
            || typeof file.sha512 !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(file.sha512)
            || !Number.isSafeInteger(file.size) || file.size <= 0 || file.size > 1024 * 1024 * 1024)
            throw new Error('Invalid release installer');
        const installer = { url: file.url, sha512: file.sha512, size: file.size };
        const manifest = { version: info.version, files: [installer], path: installer.url, sha512: installer.sha512,
            ...(typeof info.releaseDate === 'string' ? { releaseDate: info.releaseDate } : {}) };
        if (manifests.size >= 20) manifests.delete(manifests.keys().next().value);
        manifests.set(manifest.version, { manifest });
        if (version === 'latest') manifests.set('latest', { manifest, expiresAt: Date.now() + 60000 });
        return manifest;
    })();
    requests.set(version, request);
    try { return await request; }
    finally { requests.delete(version); }
};

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
const getLatestRelease = async ({ force = false } = {}) => {
    if (!force && cached && Date.now() < expiresAt) return cached;
    if (pending) return pending;
    pending = (async () => {
        try {
            const manifest = await getReleaseManifest('latest', { force });
            cached = { version: manifest.version, error: '' };
            expiresAt = Date.now() + 60000;
        } catch {
            cached = { version: cached?.version || '', error: 'releaseUnavailable' };
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
        available: !release.error && compareVersions(version, release.version) === -1,
        error: release.error,
    };
};

let releaseCheckTimer;
const startReleaseChecks = () => {
    if (releaseCheckTimer) return;
    const refresh = async () => {
        const release = await getLatestRelease({ force: true });
        if (release.error) console.error('[Station updates] Latest release unavailable; retrying in one minute.');
    };
    void refresh();
    releaseCheckTimer = setInterval(refresh, 60000);
    releaseCheckTimer.unref();
};

module.exports = { getLatestRelease, getStationUpdate, getReleaseManifest, startReleaseChecks, RELEASE_BASE };
