const defaults = Object.freeze({
    'integration.sharing.stunUrls': 'stun:stun.l.google.com:19302',
    'integration.stationLive.turnUrls': '',
    'integration.stationLive.turnUsername': '',
    'integration.stationLive.turnCredential': '',
    'integration.gmail.quotaProject': '',
    'integration.gmail.userQuotaLimit': 6000,
    'integration.gmail.projectQuotaLimit': 1200000,
    'integration.gmail.syncPaused': false,
    'integration.gmail.incrementalSync': true,
});

const normalizeRuntimeSetting = (key, value) => {
    const baseline = defaults[key];
    if (baseline === undefined || typeof value !== typeof baseline) throw new Error('invalidServerSetting');
    if (typeof baseline === 'boolean') return value;
    if (typeof baseline === 'number') {
        if (!Number.isInteger(value) || value < 125 || value > baseline) throw new Error('invalidServerSetting');
        return value;
    }
    const text = value.trim();
    if (text.length > 2048 || /[\r\n]/.test(text)) throw new Error('invalidServerSetting');
    if (key.endsWith('quotaProject') && text && !/^\d+$/.test(text)) throw new Error('invalidServerSetting');
    if (key.endsWith('Urls')) {
        const pattern = key.endsWith('stunUrls') ? /^stuns?:[^\s,/?#@]+$/ : /^turns?:[^\s,/?#@]+(?:\?transport=(?:udp|tcp))?$/;
        if (text && text.split(',').some(url => !pattern.test(url.trim()))) throw new Error('invalidServerSetting');
    }
    return text;
};

const readRuntimeConfig = async ({ db, connection } = {}) => {
    const at = new Date();
    const query = { key: { $in: Object.keys(defaults) }, scope: 'Global', status: 'Active',
        'effective.from': { $lte: at }, $or: [{ 'effective.to': null }, { 'effective.to': { $gte: at } }] };
    const records = connection
        ? await connection.db.collection('config').find(query, { projection: { key: 1, value: 1 }, maxTimeMS: 1500 }).toArray()
        : await (db || require('../models')).config.find(query, { key: 1, value: 1 }).maxTimeMS(1500).lean();
    const config = { ...defaults };
    for (const { key, value } of records) if (Object.hasOwn(defaults, key)) config[key] = normalizeRuntimeSetting(key, value);
    return config;
};

const getIceServers = async ({ db, relay = false } = {}) => {
    const config = await readRuntimeConfig({ db });
    const urls = config['integration.sharing.stunUrls'].split(',').map(url => url.trim()).filter(Boolean);
    const servers = urls.length ? [{ urls }] : [];
    const turn = config['integration.stationLive.turnUrls'].split(',').map(url => url.trim()).filter(Boolean);
    if (relay && turn.length && config['integration.stationLive.turnUsername'] && config['integration.stationLive.turnCredential'])
        servers.push({ urls: turn, username: config['integration.stationLive.turnUsername'], credential: config['integration.stationLive.turnCredential'] });
    return servers;
};

module.exports = { defaults, normalizeRuntimeSetting, readRuntimeConfig, getIceServers };
