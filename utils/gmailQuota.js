const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');

// https://developers.google.com/workspace/gmail/api/reference/quota
const METHOD_COSTS = Object.freeze({ getProfile: 1, 'history.list': 2, 'messages.list': 5,
    'threads.list': 10, 'messages.get': 20, 'messages.attachments.get': 20,
    'threads.get': 40, 'messages.send': 100 });
const WINDOW_MS = 60000;
const REQUEST_TIMEOUT_MS = 20000;
const ACTIVE_MS = 30000;

class GmailDeferred extends Error {
    constructor(nextRetryAt, reason = 'quota', waitMs = null) {
        super('Gmail work is waiting for capacity');
        this.code = 'GMAIL_DEFERRED';
        this.nextRetryAt = new Date(nextRetryAt);
        this.reason = reason;
        this.waitMs = waitMs;
    }
}

const quotaSettings = (env = process.env) => {
    const limit = (key, baseline) => {
        const value = Number(env[key] ?? baseline);
        if (!Number.isFinite(value) || value <= 0) throw new Error(`Invalid ${key}`);
        return Math.floor(Math.min(value, baseline) * 0.8);
    };
    const userBudget = limit('GMAIL_USER_QUOTA_LIMIT', 6000);
    const projectBudget = limit('GMAIL_PROJECT_QUOTA_LIMIT', 1200000);
    if (Math.min(userBudget, projectBudget) < 100) throw new Error('Gmail quota budget must allow a send request');
    return { userBudget, projectBudget };
};

const classifyError = (error, now = Date.now(), attempt = 0, random = Math.random) => {
    const status = Number(error?.response?.status ?? error?.code);
    const data = error?.response?.data?.error;
    const details = [data?.status, ...(data?.errors ?? []).map(item => item.reason),
        JSON.stringify(data?.details ?? []), error?.message].filter(Boolean).join(' ');
    const headers = error?.response?.headers;
    const retry = headers?.get?.('retry-after') ?? headers?.['retry-after'];
    let retryAt = Number.isFinite(Number(retry)) && retry !== null && retry !== undefined
        ? now + Number(retry) * 1000 : Date.parse(retry);
    const explicit = details.match(/retry after[:\s]+(\d{4}-\d\d-\d\dT[\d:.]+Z)/i);
    if (explicit) retryAt = Math.max(retryAt || 0, Date.parse(explicit[1]));
    for (const detail of data?.details || []) {
        if (!String(detail['@type']).endsWith('RetryInfo')) continue;
        const delay = detail.retryDelay;
        const seconds = typeof delay === 'string' ? Number(delay.replace(/s$/, ''))
            : Number(delay?.seconds || 0) + Number(delay?.nanos || 0) / 1e9;
        if (Number.isFinite(seconds)) retryAt = Math.max(retryAt || 0, now + seconds * 1000);
    }
    const longLimit = /dailyLimit|daily limit|mail sending|bandwidth/i.test(details);
    const quota = status === 429 || ((status === 403 || status === 400) && /quota|rate.?limit|RESOURCE_EXHAUSTED/i.test(details));
    const transient = status >= 500 || (!status && /ETIMEDOUT|ECONNRESET|EAI_AGAIN|timeout|network/i.test(`${error?.code} ${details}`));
    if (!quota && !transient) return null;
    const backoff = Math.min(64000, (2 ** attempt) * 1000 + Math.floor(random() * 1000));
    const delay = longLimit ? 60 * 60 * 1000 : Math.max(backoff, quota ? WINDOW_MS : 0);
    return { reason: longLimit ? 'dailyOrBandwidth' : quota ? 'quota' : 'transient',
        scope: /per.?project|per project|rateLimitExceeded/i.test(details) && !/per.?user|per user|userRateLimitExceeded/i.test(details)
            ? 'project' : 'mailbox',
        nextRetryAt: new Date(Math.max(now + delay, Number.isFinite(retryAt) ? retryAt : 0)) };
};

// Pure admission calculation; Mongo's CAS below serializes decisions across all workers.
const admission = (state, { mailbox, cost, urgent = false }, now, { userBudget, projectBudget }) => {
    const entries = (state.entries ?? []).filter(entry => +new Date(entry.retainUntil) > now);
    const own = entries.filter(entry => !mailbox || !entry.mailbox || entry.mailbox === mailbox);
    const active = own.filter(entry => +new Date(entry.activeUntil) > now);
    let next = Math.max(now, +new Date(state.blockedUntil || 0),
        +new Date(state.mailboxBlocks?.[mailbox || 'bootstrap'] || 0),
        +new Date(state.nextProjectAt || 0), +new Date(state.nextMailboxAt?.[mailbox || 'bootstrap'] || 0));
    if (!mailbox) next = Math.max(next, ...Object.values(state.mailboxBlocks || {}).map(value => +new Date(value)));
    const waitForBudget = (records, budget) => {
        let used = records.reduce((sum, entry) => sum + entry.cost, 0);
        for (const entry of [...records].sort((a, b) => +new Date(a.retainUntil) - +new Date(b.retainUntil))) {
            if (used + cost <= budget) break;
            next = Math.max(next, +new Date(entry.retainUntil));
            used -= entry.cost;
        }
    };
    waitForBudget(entries, projectBudget);
    waitForBudget(own, userBudget);
    if (active.length >= 2) next = Math.max(next, Math.min(...active.map(entry => +new Date(entry.activeUntil))));
    // Interactive requests get first choice, but bulk work gets a turn every five seconds.
    if (!urgent && +new Date(state.urgentUntil || 0) > now && +new Date(state.lastBackgroundAt || 0) > now - 5000)
        next = Math.max(next, Math.min(+new Date(state.urgentUntil), +new Date(state.lastBackgroundAt) + 5000));
    return { entries, next, used: own.reduce((sum, entry) => sum + entry.cost, 0) };
};

function createGmailQuota({ connection, settings = quotaSettings(), logger = console }) {
    const states = () => connection.db.collection('gmailQuota');
    const read = async project => {
        await connection.asPromise();
        try {
            await states().updateOne({ _id: project }, { $setOnInsert: { version: 0, entries: [] },
                $min: { userBudget: settings.userBudget, projectBudget: settings.projectBudget } },
                { upsert: true, writeConcern: { w: 'majority' } });
        } catch (error) { if (error.code !== 11000) throw error; }
        return states().aggregate([{ $match: { _id: project } }, { $set: { serverNow: '$$NOW' } }],
            { readConcern: { level: 'majority' } }).next();
    };
    const reserve = async ({ project, mailbox, method, urgent }) => {
        const cost = METHOD_COSTS[method];
        if (!cost) throw new Error(`Unregistered Gmail method: ${method}`);
        for (let conflict = 0; conflict < 10; conflict++) {
            const started = performance.now();
            const state = await read(project);
            const now = +state.serverNow;
            const budgets = { userBudget: Math.min(settings.userBudget, state.userBudget),
                projectBudget: Math.min(settings.projectBudget, state.projectBudget) };
            const result = admission(state, { mailbox, cost, urgent }, now, budgets);
            if (result.next > now) throw new GmailDeferred(result.next, 'quota', result.next - now);
            const id = randomUUID();
            const entry = { id, mailbox, cost, activeUntil: new Date(now + ACTIVE_MS),
                retainUntil: new Date(now + ACTIVE_MS + WINDOW_MS) };
            const patch = { entries: [...result.entries, entry],
                nextProjectAt: new Date(now + Math.max(250, Math.ceil(cost * WINDOW_MS / budgets.projectBudget))),
                [`nextMailboxAt.${mailbox || 'bootstrap'}`]: new Date(now + Math.ceil(cost * WINDOW_MS / budgets.userBudget)) };
            if (!urgent) patch.lastBackgroundAt = new Date(now);
            const saved = await states().updateOne({ _id: project, version: state.version,
                userBudget: budgets.userBudget, projectBudget: budgets.projectBudget,
                $expr: { $lte: ['$$NOW', new Date(now + 500)] } }, { $set: patch, $inc: { version: 1 } },
                { writeConcern: { w: 'majority' } });
            if (!saved.modifiedCount) continue;
            // Never dispatch a reservation delayed by a slow database or suspended process.
            if (performance.now() - started > 500) throw new GmailDeferred(now + ACTIVE_MS);
            return { id, now, used: result.used + cost };
        }
        throw new GmailDeferred(Date.now() + 1000, 'contention');
    };
    const run = async (context, method, execute, { urgent = false, attempt = 0 } = {}) => {
        if (urgent) {
            const state = await read(context.project);
            await states().updateOne({ _id: context.project }, { $max: { urgentUntil: new Date(+state.serverNow + 2000) },
                $inc: { version: 1 } }, { writeConcern: { w: 'majority' } });
        }
        let permit;
        const waitingSince = performance.now();
        while (!permit) {
            try { permit = await reserve({ ...context, method, urgent }); }
            catch (error) {
                if (!urgent || !(error instanceof GmailDeferred) || performance.now() - waitingSince >= 5000) throw error;
                await new Promise(resolve => setTimeout(resolve, Math.min(500, Math.max(50, error.waitMs || 500))));
            }
        }
        const started = performance.now();
        try {
            const result = await execute({ retry: false, retryConfig: { retry: 0 }, timeout: REQUEST_TIMEOUT_MS });
            return result;
        } catch (error) {
            const failure = classifyError(error, permit.now + (performance.now() - started), attempt);
            if (failure) {
                const field = failure.scope === 'project' || !context.mailbox ? 'blockedUntil' : `mailboxBlocks.${context.mailbox}`;
                await states().updateOne({ _id: context.project }, { $max: { [field]: failure.nextRetryAt },
                    $inc: { version: 1 } }, { writeConcern: { w: 'majority' } });
                error.gmailFailure = failure;
            }
            throw error;
        } finally {
            // Retain cost for a full minute after completion, conservatively covering dispatch latency.
            await states().updateOne({ _id: context.project }, [{ $set: {
                entries: { $map: { input: '$entries', as: 'entry', in: { $cond: [
                    { $eq: ['$$entry.id', permit.id] }, { $mergeObjects: ['$$entry', {
                        activeUntil: '$$NOW', retainUntil: { $add: ['$$NOW', WINDOW_MS] } }] }, '$$entry'] } } },
                version: { $add: ['$version', 1] },
            } }], { writeConcern: { w: 'majority' } });
            logger.info?.('gmail.request', { method, units: METHOD_COSTS[method], rollingUnits: permit.used,
                durationMs: Math.round(performance.now() - started) });
        }
    };
    return { run, reserve };
}

module.exports = { createGmailQuota, quotaSettings, admission, classifyError, GmailDeferred, METHOD_COSTS,
    WINDOW_MS, REQUEST_TIMEOUT_MS };
