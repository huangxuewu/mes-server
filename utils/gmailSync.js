const { randomUUID } = require('node:crypto');
const { SEARCH_QUERY, buildPrioritySearchQueries, toMessage } = require('./gmail');
const { prepareGmailMailbox } = require('./gmailMailbox');

// Each step makes at most one mailbox data request and commits its checkpoint with the business writes.
function createGmailSyncStep({ connection, getClient, getCandidates, prepareThreads, prepareMailbox = prepareGmailMailbox }) {
    const seen = () => connection.db.collection('gmailSyncSeen');
    let initializing;
    return async state => {
        await (initializing ||= seen().createIndex({ generation: 1 }).catch(error => { initializing = null; throw error; }));
        const client = await getClient();
        const profile = await client.profile();
        await prepareMailbox(connection, client.context.mailbox);
        const candidates = await getCandidates();
        const references = [...new Set(candidates.map(candidate => candidate.loadNumber))].sort();
        const progress = state.progress;
        if (!progress || state.identityKey !== client.identityKey) {
            const sameMailbox = state.mailbox === client.context.mailbox;
            const cursor = sameMailbox && client.incrementalSync !== false ? state.cursor : null;
            const added = cursor ? references.filter(reference => !(state.references || []).includes(reference)) : references;
            return { apply: progress ? session => seen().deleteMany({ generation: progress.generation }, { session }) : undefined,
                patch: { identityKey: client.identityKey, mailbox: client.context.mailbox,
                ...(!sameMailbox ? { lastSuccessfulSyncAt: null, newMessages: 0 } : {}),
                progress: { generation: randomUUID(), phase: cursor ? 'search' : 'boundary',
                    queries: [...buildPrioritySearchQueries(added), ...(!cursor ? [SEARCH_QUERY] : [])],
                    references, queryIndex: 0, pageToken: null, pending: [], historyStart: cursor || null },
            } };
        }
        const options = { attempt: state.attempts || 0 };
        const patch = next => ({ progress: { ...progress, ...next } });
        if (progress.pending.length) {
            const id = progress.pending[0];
            const seenId = `${progress.generation}:${progress.phase === 'search' ? 'search' : 'history'}:${id}`;
            const next = patch({ pending: progress.pending.slice(1) });
            if (await seen().findOne({ _id: seenId })) return { patch: next };
            let thread;
            try {
                const { data } = await client.request('threads.get', { id, format: 'full' }, options);
                const messages = (data.messages || []).map(toMessage);
                thread = { threadId: data.id, subject: messages[0]?.subject || '', messages };
            } catch (error) {
                if (Number(error.response?.status ?? error.code) !== 404) throw error;
            }
            const prepared = thread ? await prepareThreads([thread], profile.emailAddress, candidates, client.context.mailbox)
                : { newMessages: 0, apply: async () => {} };
            next.newMessages = (state.newMessages || 0) + prepared.newMessages;
            return { patch: next, apply: async session => {
                await prepared.apply(session);
                await seen().updateOne({ _id: seenId }, { $setOnInsert: { generation: progress.generation } }, { upsert: true, session });
            } };
        }
        if (progress.phase === 'boundary') {
            const { data } = await client.request('getProfile', {}, options);
            return { patch: patch({ historyStart: data.historyId, phase: 'search' }) };
        }
        if (progress.phase === 'search') {
            if (progress.queryIndex >= progress.queries.length) return { patch: patch({ phase: 'history', pageToken: null }) };
            const { data } = await client.request('threads.list', {
                q: progress.queries[progress.queryIndex], maxResults: 100,
                ...(progress.pageToken ? { pageToken: progress.pageToken } : {}),
            }, options);
            return { patch: patch({ pending: [...new Set((data.threads || []).map(thread => thread.id))],
                pageToken: data.nextPageToken || null,
                queryIndex: progress.queryIndex + (data.nextPageToken ? 0 : 1) }) };
        }
        if (progress.phase === 'history') {
            let data;
            try {
                ({ data } = await client.request('history.list', { startHistoryId: progress.historyStart,
                    maxResults: 100, ...(progress.pageToken ? { pageToken: progress.pageToken } : {}) }, options));
            } catch (error) {
                if (Number(error.response?.status ?? error.code) !== 404) throw error;
                // A stale history cursor requires another guarded baseline; keep stored appointments.
                return { patch: { cursor: null, progress: null }, apply: session =>
                    seen().deleteMany({ generation: progress.generation }, { session }) };
            }
            const pending = [...new Set((data.history || []).flatMap(record => [
                ...(record.messagesAdded || []).map(item => item.message.threadId),
                ...(record.labelsAdded || []).map(item => item.message.threadId),
                ...(record.labelsRemoved || []).map(item => item.message.threadId),
            ]).filter(Boolean))];
            return { patch: patch({ pending, pageToken: data.nextPageToken || null,
                phase: data.nextPageToken ? 'history' : 'finish', historyTarget: progress.historyTarget || data.historyId }) };
        }
        const prepared = await prepareThreads([], profile.emailAddress, candidates, client.context.mailbox);
        return { complete: true, patch: { cursor: progress.historyTarget || progress.historyStart,
            references: progress.references, progress: null }, apply: async session => {
            await prepared.apply(session);
            await seen().deleteMany({ generation: progress.generation }, { session });
        } };
    };
}

module.exports = { createGmailSyncStep };
