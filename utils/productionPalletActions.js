const fail = key => { throw new Error(`productionPallet.errors.${key}`); };
const validId = value => typeof value === 'string' && /^[a-f\d]{24}$/i.test(value);
const validRequest = value => typeof value === 'string' && /^[a-z\d-]{16,80}$/i.test(value);
const sameId = (a, b) => String(a || '') === String(b || '');

module.exports = ({ db, database, dayjs }) => {
    const register = async (payload, user) => {
        if (user.employeeId && !sameId(payload.lineId, user.lineId)) fail('permission');
        if (!validId(payload.lineId) || !validId(payload.runId) || !validRequest(payload.requestId)) fail('request');
        if (!Number.isSafeInteger(payload.boxes) || payload.boxes <= 0) fail('quantity');
        await db.pallet.init();
        const pallet = await database.connection.transaction(async session => {
            // Lifecycle changes and registrations share this lock, including end/register races.
            const line = await db.line.findOneAndUpdate({ _id: payload.lineId }, { $inc: { productionRevision: 1 } }, { new: true, session });
            if (!line) fail('line');
            const previous = await db.pallet.findOne({ registrationRequestId: payload.requestId }).session(session);
            if (previous) {
                if (!sameId(previous.lineId, line._id) || !sameId(previous.productionRunId, payload.runId)
                    || previous.lotNumber !== payload.lotNumber
                    || previous.boxesPerPallet !== payload.boxes || !sameId(previous.registeredBy, user._id)
                    || !sameId(previous.registeredByEmployee, user.employeeId)) fail('request');
                return previous;
            }
            const run = await db.productionRun.findOne({ _id: payload.runId, lineId: line._id, open: true }).session(session);
            if (!run || !['Running', 'Paused'].includes(run.status)) fail('run');
            if (user.employeeId && !run.crew.some(slot => slot.enabled && sameId(slot.employeeId, user.employeeId))) fail('permission');
            if (!run.lotNumber || payload.lotNumber !== run.lotNumber) fail('lotChanged');
            const { boxesPerPallet, bagsPerBox, pillowsPerBag } = run.packaging || {};
            if (![boxesPerPallet, bagsPerBox, pillowsPerBag].every(value => Number.isSafeInteger(value) && value > 0)) fail('packaging');
            const quantity = payload.boxes * bagsPerBox * pillowsPerBag;
            if (payload.boxes > boxesPerPallet || !Number.isSafeInteger(quantity)) fail('quantity');
            const now = new Date();
            if (now < run.events[run.events.length - 1].at) fail('clock');
            const stamp = dayjs(now).tz(run.timeZone);
            const date = stamp.format('YYYY-MM-DD');
            const suffix = (run.styleCode || '').replace(/\D/g, '').slice(-4) || '0000';
            const prefix = `${suffix}-${stamp.format('YYMMDD')}-`;
            const palletPrefix = `${prefix}${String(stamp.hour() * 60 + stamp.minute()).padStart(4, '0')}`;
            // Sharing the suffix counter avoids collisions between styles with the same last four digits.
            const counterId = `production-pallet:${date}:${suffix}`;
            if (!await db.counter.exists({ _id: counterId }).session(session)) {
                const existing = await db.pallet.find({ _id: { $regex: `^${prefix}` } }, { _id: 1 }).session(session).lean();
                const sequence = Math.max(0, ...existing.map(item => Number(item._id.split('-').at(-1)) || 0));
                await db.counter.updateOne({ _id: counterId }, { $setOnInsert: { sequence } }, { upsert: true, session });
            }
            const counter = await db.counter.findByIdAndUpdate(counterId, { $inc: { sequence: 1 } }, { new: true, session });
            const [created] = await db.pallet.create([{
                _id: `${palletPrefix}-${String(counter.sequence).padStart(3, '0')}`, serial: counter.sequence, lotNumber: run.lotNumber,
                productionRunId: run._id, lineId: run.lineId, lineName: run.lineName,
                productId: run.productId, productName: run.productName, styleCode: run.styleCode,
                letterCode: run.letterCode || '', clientName: run.clientName || 'TARGET', category: 'Finished Goods',
                boxesPerPallet: payload.boxes, bagsPerBox, pillowsPerBag, quantity,
                registeredAt: now, registeredBy: user._id, registeredByEmployee: user.employeeId, registrationRequestId: payload.requestId,
                date, time: now, timeZone: run.timeZone, printedAt: null, printedBy: '', status: 'Pending',
                trace: [{ date: now, by: user._id, employeeId: user.employeeId, action: `Production registered (${quantity} units)` }],
            }], { session });
            return created;
        });
        return pallet;
    };

    const preparePrint = async (payload, user) => {
        if (!validRequest(payload.requestId) || typeof payload.palletId !== 'string' || typeof payload.printer !== 'string' || !payload.printer.trim() || payload.printer.length > 200) fail('request');
        const pallet = await database.connection.transaction(async session => {
            const current = await db.pallet.findOneAndUpdate({ _id: payload.palletId }, { $inc: { revision: 1 } }, { new: true, session });
            if (!current || current.status === 'Voided') fail('pallet');
            if (user.employeeId && (!sameId(current.lineId, user.lineId) || !sameId(current.registeredByEmployee, user.employeeId))) fail('permission');
            const previous = current.printAttempts.find(attempt => attempt.requestId === payload.requestId);
            if (previous) {
                if (!sameId(previous.by, user._id) || !sameId(previous.employeeId, user.employeeId) || previous.printer !== payload.printer) fail('request');
                return current;
            }
            current.printAttempts.push({ requestId: payload.requestId, by: user._id, employeeId: user.employeeId, at: new Date(), printer: payload.printer, result: 'Pending' });
            await current.save({ session });
            return current;
        });
        return pallet;
    };

    const printResult = async (payload, user) => {
        if (!validRequest(payload.requestId) || typeof payload.palletId !== 'string' || !['Submitted', 'Failed'].includes(payload.result)) fail('request');
        const pallet = await database.connection.transaction(async session => {
            const current = await db.pallet.findOneAndUpdate({ _id: payload.palletId }, { $inc: { revision: 1 } }, { new: true, session });
            const attempt = current?.printAttempts.find(item => item.requestId === payload.requestId);
            if (!attempt || !sameId(attempt.by, user._id) || !sameId(attempt.employeeId, user.employeeId)
                || (user.employeeId && !sameId(current.lineId, user.lineId))) fail('request');
            if (attempt.result !== 'Pending') {
                if (attempt.result !== payload.result) fail('request');
                return current;
            }
            attempt.result = payload.result;
            attempt.finishedAt = new Date();
            if (payload.result === 'Submitted') {
                current.printedAt = current.printedAt || attempt.finishedAt;
                current.printedBy = current.printedBy || user.displayName || user.username || String(user._id);
            }
            await current.save({ session });
            return current;
        });
        return pallet;
    };

    return { register, preparePrint, printResult };
};
