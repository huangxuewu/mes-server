const sync = require('../dataSync');

module.exports = socket => {
    const subscribe = async (datasets, available) => {
        if (!Array.isArray(datasets) || datasets.some(name => typeof name !== 'string' || !Object.hasOwn(available, name)))
            throw Object.assign(new Error('Invalid sync subscription'), { code: 'INVALID_REQUEST' });
        await socket.join('data-sync-v1');
        for (const name of datasets) await socket.join(`data-sync:${name}`);
        return { datasets };
    };
    for (const [event, action] of Object.entries({ 'sync:status': sync.status, 'sync:snapshot': sync.snapshot, 'sync:pull': sync.pull,
        'sync:subscribe': async payload => subscribe(payload?.datasets, (await sync.status()).datasets),
    })) {
        socket.on(event, async (payload, callback) => {
            if (typeof callback !== 'function') return;
            try {
                const result = await action(payload);
                if (event === 'sync:status') {
                    // Older clients activate on status; upgraded clients explicitly acknowledge negotiation.
                    if (!payload?.negotiate) await subscribe((payload?.datasets || []).filter(name => Object.hasOwn(result.datasets, name)), result.datasets);
                    result.subscriptionRequired = true;
                }
                callback({ status: 'success', payload: result });
            } catch (error) {
                callback({ status: 'error', message: error.message, payload: { code: error.code || 'UNAVAILABLE' } });
            }
        });
    }
};
