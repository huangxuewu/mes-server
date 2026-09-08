const db = require('../../models');
const database = require('../../config/database');
const dayjs = require('../../utils/dayjs');
const { getActiveSessionUser, hasPermission } = require('../session');

const fail = key => { throw new Error(`productionRun.errors.${key}`); };
const sameId = (left, right) => String(left || '') === String(right || '');
const validId = value => typeof value === 'string' && /^[a-f\d]{24}$/i.test(value);
const pauseCodes = [110, 120, 130, 131, 200, 210, 300, 310, 400, 900, 910];
const eligibleEmployees = { isDeleted: { $ne: true }, hiringStatus: 'Active', 'employment.status': { $nin: ['Inactive', 'On Leave', 'Terminated'] } };
const crewSelection = crew => JSON.stringify((crew || []).map(slot => [String(slot.stepId), slot.slotIndex, String(slot.employeeId || ''), slot.enabled]).sort((a, b) => `${a[0]}:${a[1]}`.localeCompare(`${b[0]}:${b[1]}`)));

// LOT allocation shares the transaction with the crew snapshot and production event.
const createLot = async (crew, now, by, reason, session) => {
    const counter = await db.counter.findByIdAndUpdate('production-lot', { $inc: { sequence: 1 } }, { new: true, session });
    if (!Number.isSafeInteger(counter?.sequence) || counter.sequence < 1) fail('lot');
    return { number: `L${counter.sequence.toString(36).toUpperCase().padStart(8, '0')}`, startedAt: now, by, reason, crew };
};

const snapshotCrew = async (selection, positions, session) => {
    const keys = selection.map(slot => `${slot.stepId}:${slot.slotIndex}`);
    const activeIds = selection.filter(slot => slot.enabled).map(slot => slot.employeeId);
    if (!activeIds.length || new Set(activeIds).size !== activeIds.length || keys.length !== positions.length
        || new Set(keys).size !== keys.length || keys.some(key => !positions.some(slot => `${slot.stepId}:${slot.slotIndex}` === key))) fail('crew');
    const employees = await db.employee.find({ ...eligibleEmployees, _id: { $in: selection.map(slot => slot.employeeId).filter(Boolean) } }).session(session);
    if (selection.some(slot => slot.enabled && !employees.some(employee => sameId(employee._id, slot.employeeId)))) fail('crew');
    return selection.map(slot => {
        const employee = employees.find(item => sameId(item._id, slot.employeeId));
        const position = positions.find(item => sameId(item.stepId, slot.stepId) && item.slotIndex === slot.slotIndex);
        return { stepId: position.stepId, stepName: position.stepName, slotIndex: slot.slotIndex, enabled: slot.enabled, employeeId: slot.employeeId || null,
            employeeName: employee ? (employee.displayName || `${employee.firstName || ''} ${employee.lastName || ''}`.trim())
                : sameId(position.employeeId, slot.employeeId) ? position.employeeName || '' : '' };
    });
};

module.exports = socket => {
    socket.on('productionRun:setup', async (payload = {}, callback) => {
        try {
            const user = await getActiveSessionUser(socket);
            if (!hasPermission(user, 'update', 'production.run')) fail('permission');
            if (!validId(payload.lineId)) fail('line');
            const timeZone = await dayjs.getFactoryTimeZone();
            const date = dayjs().tz(timeZone).format('YYYY-MM-DD');
            const [line, schedule, products, departments, profiles, employees] = await Promise.all([
                db.line.findById(payload.lineId).select('name steps').lean(),
                db.productionSchedule.findOne({ date }).lean(),
                db.product.find({ status: { $nin: ['Draft', 'Discontinued'] } }).select('styleCode styleName').lean(),
                db.department.find({ status: 'Active' }).select('name teams').lean(),
                db.parameter.find({ lineId: payload.lineId }).lean(),
                db.employee.find(eligibleEmployees).select('firstName lastName displayName portrait team').lean(),
            ]);
            if (!line) fail('line');
            const assignments = (schedule?.assignments || []).flatMap(assignment => {
                const product = products.find(item => item.styleCode === assignment.styleCode);
                const department = departments.find(item => sameId(item._id, assignment.departmentId));
                const team = department?.teams?.find(item => sameId(item._id, assignment.teamId));
                if (!product || !team || !(assignment.quantity > 0)) return [];
                return [{ ...assignment, productId: product._id, productName: product.styleName, departmentName: department.name, teamName: team.name,
                    memberIds: [...new Set([...(team.members || []).map(String), ...employees.filter(employee => sameId(employee.team, team._id)).map(employee => String(employee._id)), ...(team.leader ? [String(team.leader)] : [])])] }];
            });
            callback({ status: 'success', payload: { date, timeZone, line, assignments, profiles, employees } });
        } catch (error) { callback({ status: 'error', message: error.message }); }
    });
    socket.on('productionLot:get', async (payload = {}, callback) => {
        try {
            const user = await getActiveSessionUser(socket);
            if (!hasPermission(user, 'view', 'production.run') && !hasPermission(user, 'update', 'production.run')
                && !hasPermission(user, 'create', 'production.pallet') && !hasPermission(user, 'update', 'production.pallet')) fail('permission');
            const query = typeof payload.query === 'string' ? payload.query.trim().toUpperCase() : '';
            if (!query || query.length > 100) fail('lot');
            const pallet = await db.pallet.findById(query).lean();
            const number = pallet?.lotNumber || query;
            const run = await db.productionRun.findOne({ 'lots.number': number }).lean();
            const lot = run?.lots.find(item => item.number === number);
            if (!lot) fail('lot');
            const pallets = await db.pallet.find({ productionRunId: run._id, lotNumber: number }).sort({ registeredAt: 1 }).lean();
            callback({ status: 'success', payload: { run, lot, pallets, palletId: pallet?._id || null } });
        } catch (error) { callback({ status: 'error', message: error.message }); }
    });
    socket.on('productionRuns:get', async (payload = {}, callback) => {
        try {
            const user = await getActiveSessionUser(socket);
            if (!hasPermission(user, 'view', 'production.run') && !hasPermission(user, 'update', 'production.run')) fail('permission');
            if (!validId(payload.lineId)) fail('line');
            const runs = await db.productionRun.find({ lineId: payload.lineId }).sort({ startedAt: -1 }).limit(20).lean();
            callback({ status: 'success', payload: { runs, serverTime: new Date() } });
        } catch (error) {
            callback({ status: 'error', message: error.message });
        }
    });

    for (const action of ['start', 'pause', 'resume', 'end', 'changeCrew', 'issue']) {
        socket.on(`productionRun:${action}`, async (payload = {}, callback) => {
            try {
                const user = await getActiveSessionUser(socket);
                if (!hasPermission(user, 'update', 'production.run')) fail('permission');
                if (!validId(payload.lineId)) fail('line');
                if (typeof payload.requestId !== 'string' || !/^[a-z\d-]{16,80}$/i.test(payload.requestId)) fail('request');
                if (action === 'start' && (!validId(payload.productId) || (payload.profileId && !validId(payload.profileId)))) fail('product');
                if (action === 'start' && (!payload.schedule || typeof payload.schedule.date !== 'string' || !validId(payload.schedule.departmentId) || !validId(payload.schedule.teamId))) fail('schedule');
                if (['start', 'changeCrew'].includes(action) && (!Array.isArray(payload.crew) || !payload.crew.length || payload.crew.length > 200 || payload.crew.some(slot => !slot
                    || !validId(slot.stepId) || !Number.isInteger(slot.slotIndex) || slot.slotIndex < 0 || typeof slot.enabled !== 'boolean'
                    || (slot.employeeId && !validId(slot.employeeId)) || (slot.enabled && !validId(slot.employeeId))))) fail('crew');
                if (action === 'start' && payload.settings !== undefined && (!Array.isArray(payload.settings) || payload.settings.length > 200
                    || payload.settings.some(setting => !setting || typeof setting.key !== 'string' || typeof setting.value !== 'string'
                        || !setting.key || setting.key.length > 200 || setting.value.length > 2000)
                    || new Set(payload.settings.map(setting => setting.key)).size !== payload.settings.length)) fail('profile');
                if (action !== 'start' && (!validId(payload.runId) || !Number.isInteger(payload.revision) || payload.revision < 0)) fail('request');
                const reason = typeof payload.reason === 'string' ? payload.reason.trim() : '';
                let statusCode = action === 'pause' ? (payload.statusCode ?? 110) : (action === 'end' ? 110 : 100);
                if (action === 'changeCrew' && !reason) fail('reason');
                if (['pause', 'end'].includes(action) && (!reason || !['Scheduled', 'Unscheduled'].includes(payload.stopType))) fail('stopReason');
                if (action === 'issue' && (!reason || !['Employee', 'Machine'].includes(payload.issueType)
                    || (payload.employeeId && (payload.issueType !== 'Employee' || !validId(payload.employeeId))))) fail('issue');
                if (reason.length > 500 || (action === 'pause' && (!reason || !pauseCodes.includes(statusCode)))) fail('reason');

                // Initialize uniqueness constraints and the shared counter before entering transactions.
                await db.productionRun.init();
                if (['start', 'changeCrew'].includes(action)) {
                    try { await db.counter.updateOne({ _id: 'production-lot' }, { $setOnInsert: { sequence: 0 } }, { upsert: true }); }
                    catch (error) { if (error.code !== 11000) throw error; }
                }
                const timeZone = await dayjs.getFactoryTimeZone();
                const run = await database.connection.transaction(async session => {
                    // Serialize lifecycle writes on this line, including concurrent starts.
                    const line = await db.line.findOneAndUpdate({ _id: payload.lineId }, { $inc: { productionRevision: 1 } }, { new: true, session });
                    if (!line) fail('line');
                    const now = new Date();

                    if (action === 'start') {
                        const previous = await db.productionRun.findOne({ startRequestId: payload.requestId }).session(session);
                        if (previous) {
                            if (!sameId(previous.lineId, payload.lineId) || !sameId(previous.productId, payload.productId)
                                || !sameId(previous.profileId, payload.profileId) || !sameId(previous.events[0].by, user._id)) fail('request');
                            if (payload.settings?.some(setting => !previous.settings.some(saved => saved.key === setting.key && saved.value === setting.value))) fail('request');
                            if (previous.schedule?.date !== payload.schedule.date || !sameId(previous.schedule?.departmentId, payload.schedule.departmentId)
                                || !sameId(previous.schedule?.teamId, payload.schedule.teamId) || crewSelection(previous.lots?.[0]?.crew || previous.crew) !== crewSelection(payload.crew)) fail('request');
                            return previous;
                        }
                        if (await db.productionRun.exists({ lineId: line._id, open: true }).session(session)) fail('alreadyOpen');
                        const product = await db.product.findById(payload.productId).session(session);
                        if (!product || ['Draft', 'Discontinued'].includes(product.status)) fail('product');
                        const profile = payload.profileId ? await db.parameter.findById(payload.profileId).session(session) : null;
                        if (!profile || !sameId(profile.lineId, line._id)) fail('profile');
                        if (payload.settings?.some(setting => !profile?.settings.some(saved => saved.key === setting.key))) fail('profile');
                        const date = dayjs(now).tz(timeZone).format('YYYY-MM-DD');
                        if (payload.schedule.date !== date) fail('schedule');
                        const schedule = await db.productionSchedule.findOne({ date }).session(session);
                        const assignment = schedule?.assignments.find(item => item.styleCode === product.styleCode && sameId(item.departmentId, payload.schedule.departmentId)
                            && sameId(item.teamId, payload.schedule.teamId) && item.quantity > 0);
                        const department = assignment ? await db.department.findById(assignment.departmentId).session(session) : null;
                        if (!assignment || department?.status !== 'Active' || !department.teams.some(team => sameId(team._id, assignment.teamId))) fail('schedule');
                        const positions = (line.steps || []).flatMap(step => Array.from({ length: Math.max(1, (step.mainWorkers ?? step.qualifiedWorkers ?? []).length) }, (_, slotIndex) => ({ stepId: step._id, stepName: step.name, slotIndex })));
                        const crew = await snapshotCrew(payload.crew, positions, session);
                        const lot = await createLot(crew, now, user._id, 'start', session);
                        const [created] = await db.productionRun.create([{
                            lineId: line._id, lineName: line.name,
                            productId: product._id, productName: product.styleName, styleCode: product.styleCode,
                            letterCode: product.letterCode || '', clientName: product.clientName || 'TARGET',
                            profileId: profile?._id || null, profileName: profile?.name || '',
                            settings: (profile?.settings || []).map(setting => ({ key: setting.key, value: payload.settings?.find(override => override.key === setting.key)?.value ?? setting.value })),
                            schedule: { date, styleCode: assignment.styleCode, departmentId: assignment.departmentId, teamId: assignment.teamId, quantity: assignment.quantity },
                            crew, lotNumber: lot.number, lots: [lot],
                            packaging: product.packaging,
                            businessDate: dayjs(now).tz(timeZone).format('YYYY-MM-DD'), timeZone,
                            startedAt: now, status: 'Running', open: true, startRequestId: payload.requestId,
                            events: [{ requestId: payload.requestId, action, at: now, by: user._id, byName: user.displayName || user.username || String(user._id), statusCode, lotNumber: lot.number }],
                        }], { session });
                        await db.line.updateOne({ _id: line._id }, { $set: { status: { code: 100, updatedAt: now } } }, { session });
                        return created;
                    }

                    const current = await db.productionRun.findOne({ _id: payload.runId, lineId: line._id }).session(session);
                    if (!current) fail('missing');
                    const previous = current.events.find(event => event.requestId === payload.requestId);
                    if (previous) {
                        if (previous.action !== action || previous.reason !== reason || (!['changeCrew', 'issue'].includes(action) && previous.statusCode !== statusCode) || !sameId(previous.by, user._id)) fail('request');
                        if (action === 'changeCrew' && crewSelection(current.lots.find(lot => lot.number === previous.lotNumber)?.crew) !== crewSelection(payload.crew)) fail('request');
                        if (['pause', 'end'].includes(action) && previous.stopType !== payload.stopType) fail('request');
                        if (action === 'issue' && (previous.issueType !== payload.issueType || !sameId(previous.employeeId, payload.employeeId))) fail('request');
                        return current;
                    }
                    if (current.revision !== payload.revision) fail('stale');
                    if (!current.open || (action === 'pause' && current.status !== 'Running') || (action === 'resume' && current.status !== 'Paused')) fail('transition');
                    if (now < current.events[current.events.length - 1].at) fail('clock');
                    if (action === 'changeCrew') {
                        if (crewSelection(current.crew.filter(slot => slot.enabled)) === crewSelection(payload.crew.filter(slot => slot.enabled)) && current.lotNumber) fail('unchangedCrew');
                        const crew = await snapshotCrew(payload.crew, current.crew, session);
                        const lot = await createLot(crew, now, user._id, reason, session);
                        if (current.lots.length) current.lots[current.lots.length - 1].endedAt = now;
                        current.lots.push(lot);
                        current.lotNumber = lot.number;
                        current.crew = crew;
                        statusCode = line.status.code;
                    } else if (action === 'issue') {
                        if (payload.employeeId && !current.crew.some(slot => slot.enabled && sameId(slot.employeeId, payload.employeeId))) fail('issue');
                        statusCode = line.status.code;
                    } else {
                        current.status = { pause: 'Paused', resume: 'Running', end: 'Ended' }[action];
                        current.open = action !== 'end';
                        if (action === 'end') {
                            current.endedAt = now;
                            if (current.lots.length) current.lots[current.lots.length - 1].endedAt = now;
                        }
                    }
                    current.revision += 1;
                    current.events.push({ requestId: payload.requestId, action, at: now, by: user._id,
                        byName: user.displayName || user.username || String(user._id), reason, statusCode, lotNumber: current.lotNumber,
                        ...(['pause', 'end'].includes(action) ? { stopType: payload.stopType } : {}),
                        ...(action === 'issue' ? { issueType: payload.issueType, employeeId: payload.employeeId || undefined,
                            employeeName: current.crew.find(slot => sameId(slot.employeeId, payload.employeeId))?.employeeName || '' } : {}),
                    });
                    await current.save({ session });
                    if (!['changeCrew', 'issue'].includes(action)) await db.line.updateOne({ _id: line._id }, { $set: { status: { code: statusCode, updatedAt: now } } }, { session });
                    return current;
                });
                callback({ status: 'success', payload: { run, serverTime: new Date() } });
            } catch (error) {
                callback({ status: 'error', message: error.code === 11000 ? 'productionRun.errors.conflict' : error.message });
            }
        });
    }
};
