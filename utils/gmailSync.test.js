const test = require('node:test');
const assert = require('node:assert/strict');
const modelsPath = require.resolve('../models');
require.cache[modelsPath] = { id: modelsPath, filename: modelsPath, loaded: true, exports: {} };
const { createGmailSyncStep } = require('./gmailSync');

const fixture = (respond) => {
    const seen = new Map();
    const requests = [];
    const processed = [];
    let references = ['LOAD-1'];
    const collection = { createIndex: async () => {}, findOne: async filter => seen.get(filter._id),
        updateOne: async (filter, update) => seen.set(filter._id, update.$setOnInsert),
        deleteMany: async filter => { for (const [id, doc] of seen) if (doc.generation === filter.generation) seen.delete(id); } };
    const connection = { db: { collection: () => collection } };
    const client = { identityKey: 'credentials', context: { mailbox: 'mailbox' },
        profile: async () => ({ emailAddress: 'test@example.com' }),
        request: async (method, params) => {
            requests.push({ method, params });
            if (method === 'threads.get') return { data: { id: params.id, messages: [{ id: `${params.id}-message`,
                threadId: params.id, internalDate: '1', payload: { headers: [], body: {} } }] } };
            return { data: await respond(method, params) };
        } };
    const options = { connection, getClient: async () => client, prepareMailbox: async () => {},
        getCandidates: async () => references.map(loadNumber => ({ loadNumber })),
        prepareThreads: async threads => ({ newMessages: threads.length,
            apply: async () => { processed.push(...threads.map(thread => thread.threadId)); } }) };
    let step = createGmailSyncStep(options);
    let state = { newMessages: 0 };
    const advance = async () => {
        const result = await step(state);
        await result.apply?.({});
        state = { ...state, ...result.patch };
        return result.complete;
    };
    const finish = async () => {
        for (let index = 0; index < 1200; index++) if (await advance()) return;
        throw new Error('Sync did not finish');
    };
    return { requests, processed, client, advance, finish, state: () => state,
        restart: () => { step = createGmailSyncStep(options); },
        setReferences: value => { references = value; } };
};

test('baseline follows every page, deduplicates overlapping searches and replays arrivals during scan', async () => {
    const f = fixture(async (method, params) => {
        if (method === 'getProfile') return { historyId: '10' };
        if (method === 'threads.list') {
            if (params.q.includes('newer_than')) return { threads: [{ id: 'thread-0' }] };
            const page = Number(params.pageToken || 0);
            return { threads: Array.from({ length: 100 }, (_, index) => ({ id: `thread-${page * 100 + index}` })),
                ...(page < 4 ? { nextPageToken: String(page + 1) } : {}) };
        }
        assert.equal(params.startHistoryId, '10');
        return { historyId: '20', history: [{ messagesAdded: [{ message: { threadId: 'late-arrival' } }] }] };
    });
    for (let index = 0; index < 120; index++) await f.advance();
    f.restart();
    await f.finish();
    assert.equal(f.processed.length, 501);
    assert.equal(new Set(f.processed).size, 501);
    assert.equal(f.state().cursor, '20');
});

test('unchanged incremental sync performs no full thread downloads', async () => {
    const f = fixture(async method => method === 'getProfile' ? { historyId: '10' }
        : method === 'threads.list' ? { threads: [] } : { historyId: '20', history: [] });
    await f.finish();
    f.requests.length = 0;
    await f.finish();
    assert.deepEqual(f.requests.map(item => item.method), ['history.list']);
});

test('new active loads backfill old mail across categories with an existing history cursor', async () => {
    const f = fixture(async method => method === 'getProfile' ? { historyId: '10' }
        : method === 'threads.list' ? { threads: [] } : { historyId: '20', history: [] });
    await f.finish();
    f.requests.length = 0;
    f.setReferences(['LOAD-1', 'OLD-LOAD-2']);
    await f.finish();
    const searches = f.requests.filter(item => item.method === 'threads.list');
    assert.equal(searches.length, 1);
    assert.equal(searches[0].params.q, '{"OLD-LOAD-2"}');
    assert.deepEqual(f.state().references, ['LOAD-1', 'OLD-LOAD-2']);
});

test('paginated history commits the first response boundary and deduplicates across the last page', async () => {
    const f = fixture(async (method, params) => {
        if (method === 'getProfile') return { historyId: '10' };
        if (method === 'threads.list') return { threads: [] };
        return { historyId: params.pageToken ? '30' : '20',
            ...(!params.pageToken ? { nextPageToken: 'second' } : {}),
            history: [{ messagesAdded: [{ message: { threadId: 'changed' } }] }] };
    });
    await f.finish();
    assert.deepEqual(f.processed, ['changed']);
    assert.equal(f.state().cursor, '20');
});

test('expired history resets to a paced baseline, while a deleted thread only skips that thread', async () => {
    let expired = false;
    const f = fixture(async method => {
        if (method === 'getProfile') return { historyId: '10' };
        if (method === 'threads.list') return { threads: [] };
        if (!expired) { expired = true; const error = new Error('cursor expired'); error.code = 404; throw error; }
        return { historyId: '20', history: [] };
    });
    await f.finish();
    assert.equal(f.requests.filter(item => item.method === 'getProfile').length, 2);
    assert.equal(f.state().cursor, '20');
    const original = f.client.request;
    f.client.request = async (method, params) => {
        if (method === 'history.list') return { data: { historyId: '30', history: [{ messagesAdded: [{ message: { threadId: 'deleted' } }] }] } };
        if (method === 'threads.get') { const error = new Error('deleted'); error.code = 404; throw error; }
        return original(method, params);
    };
    await f.finish();
    assert.equal(f.state().cursor, '30');
    assert.equal(f.processed.length, 0);
});
