const { randomInt, randomUUID } = require('node:crypto');

const createSignaturePadPairing = ({ model, now = Date.now, random = randomInt }) => ({
    async reserve(owner, deviceId) {
        if (typeof deviceId !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(deviceId)) throw new Error('signaturePad.invalidDevice');
        const previous = await model.findOne({ owner, cancelled: false, consumed: false, attempts: { $lt: 5 }, expiresAt: { $gt: new Date(now()) } }).lean();
        if (previous) {
            if (previous.deviceId !== deviceId) throw new Error('signaturePad.busy');
            return { reservationId: previous.reservationId, code: previous._id, expiresAt: +previous.expiresAt };
        }
        // Retain consumed/cancelled leases until expiry so a code still on a phone cannot be reused.
        await model.deleteMany({ expiresAt: { $lte: new Date(now()) } });
        const start = random(10000);
        for (let offset = 0; offset < 10000; offset++) {
            const code = String((start + offset) % 10000).padStart(4, '0');
            const reservationId = randomUUID(), expiresAt = new Date(now() + 120000);
            try {
                await model.create({ _id: code, reservationId, owner, deviceId, expiresAt });
                return { reservationId, code, expiresAt: +expiresAt };
            } catch (error) { if (error.code !== 11000) throw error; }
        }
        throw new Error('signaturePad.codesFull');
    },
    async confirm(owner, reservationId, code) {
        if (typeof reservationId !== 'string' || !/^[a-f0-9-]{36}$/.test(reservationId)) throw new Error('signaturePad.codeExpired');
        if (typeof code !== 'string' || !/^\d{4}$/.test(code)) throw new Error('signaturePad.invalidCode');
        const lease = await model.findOneAndUpdate({ owner, reservationId, cancelled: false, attempts: { $lt: 5 }, expiresAt: { $gt: new Date(now()) } },
            { $inc: { attempts: 1 } }, { new: true }).lean();
        if (!lease) throw new Error('signaturePad.codeExpired');
        if (lease._id !== code) throw new Error(lease.attempts >= 5 ? 'signaturePad.codeExpired' : 'signaturePad.invalidCode');
        await model.updateOne({ _id: lease._id, reservationId }, { $set: { consumed: true } });
        return { reservationId, deviceId: lease.deviceId };
    },
    async cancel(owner, reservationId) {
        if (typeof reservationId !== 'string' || !/^[a-f0-9-]{36}$/.test(reservationId)) throw new Error('signaturePad.codeExpired');
        await model.updateOne({ owner, reservationId }, { $set: { cancelled: true } });
    },
});

module.exports = { createSignaturePadPairing };
