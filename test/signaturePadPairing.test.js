const test = require('node:test');
const assert = require('node:assert/strict');
const { createSignaturePadPairing } = require('../utils/signaturePadPairing');

const setup = () => {
    let time = 1000;
    const rows = new Map();
    const matches = (row, query) => Object.entries(query).every(([key, value]) => {
        if (value && typeof value === 'object') return Object.entries(value).every(([operator, limit]) => ({ $gt: row[key] > limit, $lte: row[key] <= limit, $lt: row[key] < limit })[operator]);
        return row[key] === value;
    });
    const find = query => [...rows.values()].find(row => matches(row, query));
    const model = {
        findOne: query => ({ lean: async () => find(query) }),
        deleteMany: async query => { for (const [key, row] of rows) if (matches(row, query)) rows.delete(key); },
        create: async row => {
            if (rows.has(row._id)) throw Object.assign(new Error('duplicate'), { code: 11000 });
            rows.set(row._id, { attempts: 0, consumed: false, cancelled: false, ...row });
        },
        findOneAndUpdate: (query, update) => ({ lean: async () => {
            const row = find(query);
            if (!row) return null;
            for (const [key, amount] of Object.entries(update.$inc || {})) row[key] += amount;
            return { ...row };
        } }),
        updateOne: async (query, update) => { const row = find(query); if (row) Object.assign(row, update.$set); },
    };
    return { rows, pairing: createSignaturePadPairing({ model, random: () => 7, now: () => time }), advance: milliseconds => { time += milliseconds; } };
};

test('concurrent stations get distinct four-digit codes despite random collisions', async () => {
    const { pairing } = setup();
    const leases = await Promise.all(Array.from({ length: 30 }, (_, i) => pairing.reserve(`station-${i}`, `pad-${i}`)));
    assert.equal(new Set(leases.map(lease => lease.code)).size, 30);
    assert.equal(leases[0].code, '0007');
    assert.ok(leases.every(lease => /^\d{4}$/.test(lease.code)));
});
test('ownership, five-attempt limit and expiry prevent unauthorized pairing', async () => {
    const { pairing, advance } = setup();
    const lease = await pairing.reserve('owner', 'pad');
    await assert.rejects(pairing.confirm('other', lease.reservationId, lease.code), /codeExpired/);
    for (let i = 0; i < 5; i++) await assert.rejects(pairing.confirm('owner', lease.reservationId, '9999'), i === 4 ? /codeExpired/ : /invalidCode/);
    await assert.rejects(pairing.confirm('owner', lease.reservationId, lease.code), /codeExpired/);
    advance(120001);
    await assert.rejects(pairing.confirm('owner', lease.reservationId, lease.code), /codeExpired/);
});
test('successful and cancelled codes remain reserved until expiration', async () => {
    const { pairing, advance } = setup();
    const first = await pairing.reserve('a', 'pad1');
    assert.equal((await pairing.confirm('a', first.reservationId, first.code)).deviceId, 'pad1');
    const second = await pairing.reserve('b', 'pad2');
    assert.notEqual(first.code, second.code);
    await pairing.cancel('b', second.reservationId);
    await assert.rejects(pairing.confirm('b', second.reservationId, second.code), /codeExpired/);
    const third = await pairing.reserve('c', 'pad3');
    assert.notEqual(second.code, third.code);
    advance(120001);
    assert.equal((await pairing.reserve('d', 'pad4')).code, first.code);
});
test('same owner can resume a pending reservation but cannot swap its pad', async () => {
    const { pairing } = setup();
    const first = await pairing.reserve('owner', 'pad');
    assert.deepEqual(await pairing.reserve('owner', 'pad'), first);
    await assert.rejects(pairing.reserve('owner', 'another'), /busy/);
});
