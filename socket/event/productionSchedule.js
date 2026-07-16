const db = require("../../models");
const { getSessionUserId } = require("../session");

const isCompleteAssignment = a =>
    a?.styleCode && a?.teamId && a?.departmentId && Number(a.quantity) > 0;

const normalizeAssignments = assignments =>
    (assignments || [])
        .filter(isCompleteAssignment)
        .map(a => ({
            departmentId: a.departmentId,
            styleCode: String(a.styleCode),
            teamId: a.teamId,
            quantity: parseInt(a.quantity, 10) || 0,
        }));

module.exports = (socket) => {
    socket.on('productionSchedules:get', async ({ rangeStart, rangeEnd } = {}, callback) => {
        try {
            if (!rangeStart || !rangeEnd)
                return callback?.({ status: 'error', message: 'rangeStart and rangeEnd are required' });

            const [dates, settings] = await Promise.all([
                db.productionSchedule.find({
                    date: { $gte: rangeStart, $lte: rangeEnd },
                }).sort({ date: 1 }).lean(),
                db.productionSetting.findOne({ rangeStart, rangeEnd }).lean(),
            ]);

            callback?.({
                status: 'success',
                message: 'Production schedules fetched successfully',
                payload: { dates, settings },
            });
        } catch (error) {
            callback?.({ status: 'error', message: error.message });
        }
    });

    socket.on('productionSchedules:save', async (payload = {}, callback) => {
        try {
            const { rangeStart, rangeEnd, anchorOrderId, dates, settings } = payload;

            if (!rangeStart || !rangeEnd)
                return callback?.({ status: 'error', message: 'rangeStart and rangeEnd are required' });

            if (!Array.isArray(dates))
                return callback?.({ status: 'error', message: 'dates array is required' });

            const updatedBy = getSessionUserId(socket);

            if (dates.length) {
                await db.productionSchedule.bulkWrite(
                    dates.map(({ date, assignments }) => ({
                        updateOne: {
                            filter: { date },
                            update: {
                                $set: {
                                    date,
                                    assignments: normalizeAssignments(assignments),
                                    updatedBy,
                                },
                            },
                            upsert: true,
                        },
                    })),
                    { ordered: false },
                );
            }

            if (settings) {
                await db.productionSetting.findOneAndUpdate(
                    { rangeStart, rangeEnd },
                    {
                        $set: {
                            rangeStart,
                            rangeEnd,
                            anchorOrderId: anchorOrderId || null,
                            disabledPOs: settings.disabledPOs || [],
                            bufferRates: settings.bufferRates || {},
                            updatedBy,
                        },
                    },
                    { upsert: true, new: true },
                );
            }

            callback?.({
                status: 'success',
                message: 'Production plan saved successfully',
                payload: { savedDates: dates.length },
            });
        } catch (error) {
            callback?.({ status: 'error', message: error.message });
        }
    });
};
