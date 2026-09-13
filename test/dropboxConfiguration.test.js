const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');

const fixture = (env = {}) => {
    let records = [];
    const queries = [];
    const db = { config: { find: (query, projection) => {
        queries.push({ query, projection });
        return { maxTimeMS: timeout => {
            assert.equal(timeout, 5000);
            return { lean: async () => records };
        } };
    } } };
    const requests = [];
    const context = { module: { exports: {} }, process: { env },
        fetch: async (...args) => requests.push(args),
        require: name => {
            if (name === '../models') return db;
            assert.equal(name, 'dropbox');
            return { Dropbox: class { constructor(options) { this.options = options; } } };
        },
    };
    vm.runInNewContext(fs.readFileSync(require.resolve('../utils/documentStorage'), 'utf8'), context);
    return { ...context.module.exports, queries, requests,
        set: values => { records = Object.entries(values).map(([key, value]) => ({ key: `integration.dropbox.${key}`, value })); } };
};

test('screenshots use existing active MES Dropbox settings without environment credentials', async () => {
    const env = fixture();
    env.set({ clientId: ' saved-id ', clientSecret: 'saved-secret', refreshToken: 'saved-token' });
    const client = await env.getConfiguredDropbox();
    assert.equal(client.options.clientId, 'saved-id');
    assert.equal(client.options.clientSecret, 'saved-secret');
    assert.equal(client.options.refreshToken, 'saved-token');
    const { query } = env.queries[0];
    assert.equal(query.status, 'Active');
    assert.ok(query['effective.from'].$lte);
    assert.equal(query.$or[0]['effective.to'], null);
    assert.equal(query.$or[1]['effective.to'].$gte, query['effective.from'].$lte);
    assert.equal(query.key.$in.length, 3);
    env.set({ clientId: 'saved-id', clientSecret: 'saved-secret', refreshToken: 'rotated-token' });
    assert.equal((await env.getConfiguredDropbox()).options.refreshToken, 'rotated-token');
});

test('missing saved credentials never fall back to runtime values', async () => {
    const env = fixture({ DROPBOX_CLIENT_ID: 'env-id', DROPBOX_CLIENT_SECRET: 'env-secret', DROPBOX_REFRESH_TOKEN: 'env-token' });
    env.set({ clientId: 'saved-id', clientSecret: ' ' });
    const client = await env.getConfiguredDropbox();
    assert.equal(client, null);
    const missing = fixture();
    missing.set({ clientId: 'saved-id' });
    assert.equal(await missing.getConfiguredDropbox(), null);
});

test('configured Dropbox retains cancellation for OAuth and storage requests', async () => {
    const env = fixture();
    env.set({ clientId: 'id', clientSecret: 'secret', refreshToken: 'token' });
    const controller = new AbortController();
    const client = await env.getConfiguredDropbox({ signal: controller.signal });
    await client.options.fetch('https://api.dropboxapi.com/oauth2/token', { method: 'POST' });
    assert.equal(env.requests[0][1].signal, controller.signal);
    controller.abort();
    await assert.rejects(env.getConfiguredDropbox({ signal: controller.signal }), { name: 'AbortError' });
});
