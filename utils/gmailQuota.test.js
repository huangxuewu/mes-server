const test = require('node:test');
const assert = require('node:assert/strict');
const { admission, quotaSettings, classifyError, METHOD_COSTS, WINDOW_MS } = require('./gmailQuota');

test('database duplicate keys and other non-HTTP numeric codes are not transient Gmail failures', () => {
    for (const code of [11000, '11000', 600, 8000]) {
        assert.equal(classifyError({ code, message: 'E11000 duplicate key error' }), null);
    }
    for (const code of [500, '503', 599, 'ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN']) {
        assert.equal(classifyError({ code }).reason, 'transient');
    }
});

test('budgets stay below verified limits and reject invalid configuration', () => {
    assert.deepEqual(quotaSettings({}), { userBudget: 4800, projectBudget: 960000 });
    assert.equal(quotaSettings({ 'integration.gmail.userQuotaLimit': '3000' }).userBudget, 2400);
    assert.equal(quotaSettings({ 'integration.gmail.userQuotaLimit': '15000' }).userBudget, 4800);
    assert.throws(() => quotaSettings({ 'integration.gmail.userQuotaLimit': 'no' }));
});

test('500 thread reads plus mixed operations fit every rolling window, including boundaries', () => {
    const settings = { userBudget: 4800, projectBudget: 6000 };
    const methods = ['getProfile', 'threads.list', ...Array(500).fill('threads.get'),
        'messages.send', 'messages.get', 'history.list'];
    const state = { entries: [] };
    const dispatched = [];
    let now = 100000;
    for (const method of methods) {
        const cost = METHOD_COSTS[method];
        let result = admission(state, { mailbox: 'mailbox', cost }, now, settings);
        now = result.next;
        result = admission(state, { mailbox: 'mailbox', cost }, now, settings);
        assert.equal(result.next, now);
        state.entries = [...result.entries, { mailbox: 'mailbox', cost, activeUntil: new Date(0), retainUntil: new Date(now + WINDOW_MS) }];
        dispatched.push({ now, cost });
        state.nextMailboxAt = { mailbox: new Date(now + cost * WINDOW_MS / settings.userBudget) };
        state.nextProjectAt = new Date(now + 250);
        for (const end of [now, now + 1]) {
            assert.ok(dispatched.filter(item => item.now > end - WINDOW_MS && item.now <= end)
                .reduce((sum, item) => sum + item.cost, 0) <= settings.userBudget);
        }
    }
    assert.ok(now > 100000 + 240000);
});

test('shared project, unknown mailbox, active calls and urgent traffic all constrain admission', () => {
    const now = 100000;
    const state = { entries: [
        { mailbox: 'a', cost: 100, activeUntil: new Date(now + 20000), retainUntil: new Date(now + 60000) },
        { mailbox: 'a', cost: 100, activeUntil: new Date(now + 10000), retainUntil: new Date(now + 60000) },
    ] };
    assert.equal(admission(state, { mailbox: 'a', cost: 1 }, now, { userBudget: 4800, projectBudget: 960000 }).next, now + 10000);
    assert.equal(admission(state, { mailbox: 'b', cost: 1 }, now, { userBudget: 4800, projectBudget: 200 }).next, now + 60000);
    assert.equal(admission(state, { mailbox: null, cost: 1 }, now, { userBudget: 200, projectBudget: 960000 }).next, now + 60000);
    const urgent = { entries: [], urgentUntil: new Date(now + 2000), lastBackgroundAt: new Date(now - 4000) };
    assert.equal(admission(urgent, { mailbox: 'a', cost: 40 }, now, quotaSettings({})).next, now + 1000);
    assert.equal(admission(urgent, { mailbox: 'a', cost: 100, urgent: true }, now, quotaSettings({})).next, now);
});

test('quota errors honor retry time; daily limits and permissions stay distinct', () => {
    const now = 100000;
    const error = { response: { status: 403, headers: { 'retry-after': '180' }, data: { error: {
        errors: [{ reason: 'userRateLimitExceeded' }],
    } } } };
    const result = classifyError(error, now, 0, () => 0);
    assert.equal(result.scope, 'mailbox');
    assert.equal(+result.nextRetryAt, now + 180000);
    assert.equal(classifyError({ response: { status: 429 }, message: 'Mail sending' }, now).reason, 'dailyOrBandwidth');
    assert.equal(classifyError({ response: { status: 403 }, message: 'Insufficient Permission' }, now), null);
    assert.equal(classifyError({ response: { status: 401 } }, now), null);
    assert.equal(+classifyError({ response: { status: 503 } }, now, 2, () => 0).nextRetryAt, now + 4000);
    const dated = { response: { status: 429, headers: new Headers({ 'retry-after': new Date(now + 120000).toUTCString() }) } };
    assert.equal(+classifyError(dated, now).nextRetryAt, now + 120000);
    const structured = { response: { status: 429, data: { error: { details: [
        { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '180s' },
    ] } } } };
    assert.equal(+classifyError(structured, now).nextRetryAt, now + 180000);
});
