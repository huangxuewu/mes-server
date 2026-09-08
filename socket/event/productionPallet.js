const db = require('../../models');
const database = require('../../config/database');
const dayjs = require('../../utils/dayjs');
const { getActiveSessionUser, hasPermission } = require('../session');
const { getProductionOutput } = require('../../utils/productionMetrics');
const actions = require('../../utils/productionPalletActions')({ db, database, dayjs });

const fail = key => { throw new Error(`productionPallet.errors.${key}`); };
const validId = value => typeof value === 'string' && /^[a-f\d]{24}$/i.test(value);
const canRead = user => hasPermission(user, 'view', 'production.run') || hasPermission(user, 'update', 'production.run')
    || hasPermission(user, 'create', 'production.pallet') || hasPermission(user, 'update', 'production.pallet');

module.exports = socket => {
    socket.on('productionPallets:get', async (payload = {}, callback) => {
        try {
            const user = await getActiveSessionUser(socket);
            if (!canRead(user)) fail('permission');
            if (!validId(payload.lineId) || (payload.runId && !validId(payload.runId))) fail('line');
            const openRun = await db.productionRun.findOne({ lineId: payload.lineId, open: true }).lean();
            const run = payload.runId
                ? await db.productionRun.findOne({ _id: payload.runId, lineId: payload.lineId }).lean()
                : openRun || await db.productionRun.findOne({ lineId: payload.lineId }).sort({ startedAt: -1 }).lean();
            if (payload.runId && !run) fail('run');
            const query = { lineId: payload.lineId };
            if (payload.beforeId) {
                const before = await db.pallet.findOne({ _id: payload.beforeId, lineId: payload.lineId }).lean();
                if (!before?.registeredAt) fail('request');
                query.$or = [{ registeredAt: { $lt: before.registeredAt } }, { registeredAt: before.registeredAt, _id: { $lt: before._id } }];
            }
            const history = await db.pallet.find(query).sort({ registeredAt: -1, _id: -1 }).limit(51).lean();
            const now = new Date();
            const { totals, buckets } = await getProductionOutput(db, run, now);
            callback({ status: 'success', payload: { openRun, run, totals, buckets, history: history.slice(0, 50), nextBeforeId: history.length > 50 ? history[49]._id : null, serverTime: now } });
        } catch (error) { callback({ status: 'error', message: error.message }); }
    });

    socket.on('pallet:register', async (payload = {}, callback) => {
        try {
            const user = await getActiveSessionUser(socket);
            if (!hasPermission(user, 'create', 'production.pallet')) fail('permission');
            const pallet = await actions.register(payload, user);
            callback({ status: 'success', payload: pallet });
        } catch (error) { callback({ status: 'error', message: error.code === 11000 ? 'productionPallet.errors.conflict' : error.message }); }
    });

    socket.on('pallet:preparePrint', async (payload = {}, callback) => {
        try {
            const user = await getActiveSessionUser(socket);
            if (!hasPermission(user, 'create', 'production.pallet') && !hasPermission(user, 'update', 'production.pallet')) fail('permission');
            const pallet = await actions.preparePrint(payload, user);
            callback({ status: 'success', payload: pallet });
        } catch (error) { callback({ status: 'error', message: error.code === 11000 ? 'productionPallet.errors.conflict' : error.message }); }
    });

    socket.on('pallet:printResult', async (payload = {}, callback) => {
        try {
            const user = await getActiveSessionUser(socket);
            if (!hasPermission(user, 'create', 'production.pallet') && !hasPermission(user, 'update', 'production.pallet')) fail('permission');
            const pallet = await actions.printResult(payload, user);
            callback({ status: 'success', payload: pallet });
        } catch (error) { callback({ status: 'error', message: error.code === 11000 ? 'productionPallet.errors.conflict' : error.message }); }
    });

    socket.on('pallet:void', async (payload = {}, callback) => {
        try {
            const user = await getActiveSessionUser(socket);
            if (!hasPermission(user, 'delete', 'production.pallet')) fail('permission');
            const reason = typeof payload.reason === 'string' ? payload.reason.trim() : '';
            if (typeof payload.palletId !== 'string' || !reason || reason.length > 500) fail('reason');
            const pallet = await database.connection.transaction(async session => {
                const current = await db.pallet.findOneAndUpdate({ _id: payload.palletId }, { $inc: { revision: 1 } }, { new: true, session });
                if (!current) fail('pallet');
                if (current.status === 'Voided') return current;
                if (current.status === 'Putaway') fail('putaway');
                current.status = 'Voided';
                current.voidedAt = new Date(); current.voidedBy = user._id; current.voidReason = reason;
                current.trace.push({ date: current.voidedAt, by: user._id, action: `Voided: ${reason}` });
                await current.save({ session });
                await db.storage.deleteMany({ batchNumber: current._id }, { session });
                return current;
            });
            callback({ status: 'success', payload: pallet });
        } catch (error) { callback({ status: 'error', message: error.message }); }
    });
};
