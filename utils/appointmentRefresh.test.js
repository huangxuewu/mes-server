const test = require('node:test');
const assert = require('node:assert/strict');
const { isRateLimitError, publicStatus } = require('./appointmentRefresh');

test('recognizes Gmail numeric and named quota errors', () => {
    assert.equal(isRateLimitError({ code: '429' }), true);
    assert.equal(isRateLimitError({ message: 'userRateLimitExceeded' }), true);
    assert.equal(isRateLimitError({ code: 500, message: 'Server error' }), false);
});

test('waiting status retains the last successful check instead of reporting a fresh check', () => {
    const lastSuccessfulSyncAt = new Date('2026-09-08T12:00:00Z');
    const nextRetryAt = new Date('2026-09-08T12:05:00Z');
    const result = publicStatus({ syncStatus: 'waiting', lastSuccessfulSyncAt, nextRetryAt });
    assert.equal(result.checkedAt, lastSuccessfulSyncAt);
    assert.equal(result.nextRetryAt, nextRetryAt);
    assert.equal(result.rateLimited, true);
    assert.equal(result.cached, true);
});

test('an initial queued job has no successful timestamp and exposes no internal checkpoint', () => {
    const result = publicStatus({ syncStatus: 'queued', progress: { pending: ['private'] }, owner: 'worker' });
    assert.equal(result.checkedAt, null);
    assert.equal(result.progress, undefined);
    assert.equal(result.owner, undefined);
});
