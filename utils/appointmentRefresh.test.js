const test = require("node:test");
const assert = require("node:assert/strict");
const { createAppointmentRefreshCoordinator, isRateLimitError } = require("./appointmentRefresh");

test("recognizes Gmail numeric and named quota errors", () => {
    assert.equal(isRateLimitError({ code: "429" }), true);
    assert.equal(isRateLimitError({ message: "userRateLimitExceeded" }), true);
    assert.equal(isRateLimitError({ code: 500, message: "Server error" }), false);
});

test("concurrent clients share one in-flight appointment refresh", async () => {
    let calls = 0;
    let release;
    const coordinator = createAppointmentRefreshCoordinator();
    const execute = () => {
        calls++;
        return new Promise(resolve => { release = resolve; });
    };

    const first = coordinator.run({ execute });
    const second = coordinator.run({ execute });
    release({ newMessages: 2, threads: [{ threadId: "thread-1" }] });

    const [firstResult, secondResult] = await Promise.all([first, second]);
    assert.equal(calls, 1);
    assert.deepEqual(secondResult, firstResult);
});

test("automatic refreshes use the shared result until the interval expires", async () => {
    let currentTime = 1000;
    let calls = 0;
    const coordinator = createAppointmentRefreshCoordinator({
        intervalMs: 300000,
        now: () => currentTime,
    });
    const execute = async () => {
        calls++;
        return { newMessages: 1, threads: [] };
    };

    await coordinator.run({ execute });
    currentTime += 60000;
    const cached = await coordinator.run({ execute });
    currentTime += 300000;
    await coordinator.run({ execute });

    assert.equal(calls, 2);
    assert.equal(cached.cached, true);
    assert.equal(cached.newMessages, 0);
});

test("manual refresh bypasses the interval but still shares an in-flight request", async () => {
    let calls = 0;
    const coordinator = createAppointmentRefreshCoordinator();
    const execute = async () => {
        calls++;
        return { newMessages: 0, threads: [] };
    };

    await coordinator.run({ execute });
    await coordinator.run({ force: true, execute });

    assert.equal(calls, 2);
});

test("rate-limit responses activate backoff and reuse the last successful result", async () => {
    let currentTime = 1000;
    let calls = 0;
    const coordinator = createAppointmentRefreshCoordinator({
        backoffMs: 300000,
        now: () => currentTime,
    });
    const success = async () => {
        calls++;
        return { newMessages: 1, threads: [{ threadId: "thread-1" }] };
    };

    await coordinator.run({ execute: success });
    const limited = await coordinator.run({
        force: true,
        execute: async () => {
            calls++;
            const error = new Error("rateLimitExceeded");
            error.response = { status: 429 };
            throw error;
        },
    });
    const blocked = await coordinator.run({ force: true, execute: success });

    assert.equal(calls, 2);
    assert.equal(limited.rateLimited, true);
    assert.equal(blocked.rateLimited, true);
    assert.equal(blocked.cached, true);
});
