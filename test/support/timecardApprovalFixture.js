const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const mongoose = require('mongoose');
const dayjs = require('dayjs');
const { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');

dayjs.extend(require('dayjs/plugin/utc'));
dayjs.extend(require('dayjs/plugin/timezone'));
dayjs.getFactoryTimeZone = async () => 'America/New_York';
dayjs.businessDate = async () => '2026-09-11';
const timecardApprovalFixture = async (uri, sources = {}) => {
    assert.match(uri, /^mongodb:\/\/(127\.0\.0\.1|localhost):\d+\/data_sync_test_[a-z\d_]+(?:\?|$)/i);
    const connection = await mongoose.createConnection(uri, {
        dbName: `data_sync_test_approval_${randomUUID().replaceAll('-', '')}`, monitorCommands: true,
    }).asPromise();
    const close = async () => { await connection.dropDatabase(); await connection.close(); };
    const commands = [];
    connection.getClient().on('commandStarted', event => {
        if (['find', 'getMore', 'update', 'findAndModify'].includes(event.commandName)) commands.push(event.command);
    });
    const db = {};
    for (const name of ['employee', 'workSchedule', 'workScheduleTemplate', 'config'])
        db[name] = connection.model(name, new mongoose.Schema({}, { strict: false }), name);
    db.user = connection.model('User', new mongoose.Schema({}, { strict: false }), 'user');
    const quiet = { log() {}, error() {}, info() {} };
    const database = { model: (name, schema, collection) => {
        if (!schema) return connection.model(name);
        const model = connection.model(name, schema, collection);
        model.watch = () => new EventEmitter();
        return model;
    } };
    const evaluate = (file, dependencies, before) => {
        let source = sources[file] ?? fs.readFileSync(path.join(__dirname, '../..', file), 'utf8');
        if (before) source = source.slice(0, source.indexOf(before)) + '\nmodule.exports = Timecard;';
        const module = { exports: {} };
        vm.runInNewContext(source, { module, Date, console: quiet, require: name =>
            Object.hasOwn(dependencies, name) ? dependencies[name] : require(name) });
        return module.exports;
    };
    const modelDependencies = { mongoose, '../utils/dayjs': dayjs, '../config/database': database, '../socket/io': { io: {} } };
    db.timecard = evaluate('models/timecard.js', modelDependencies, 'Timecard.watch(');
    db.changeRequest = evaluate('models/changeRequest.js', modelDependencies);
    await Promise.all([db.timecard.init(), db.changeRequest.init()]);
    const actor = await db.user.create({ username: 'approver', displayName: 'Approver', role: 'Admin' });
    const submitter = await db.user.create({ username: 'requester', displayName: 'Requester', role: 'User' });
    const employee = await db.employee.create({ department: new mongoose.Types.ObjectId(), team: new mongoose.Types.ObjectId(), portrait: 'x'.repeat(200000) });
    await db.workScheduleTemplate.create({ isDefault: true, applyScope: 'all', workStartTime: '08:00', workEndTime: '16:30' });
    const timecard = await db.timecard.create({ employeeId: employee._id, date: '2026-09-11', punches: [
        { type: 'Clock In', time: new Date('2026-09-11T12:00:00Z'), method: 'Station' },
        { type: 'Clock Out', time: new Date('2026-09-11T20:00:00Z'), method: 'Station' },
    ] });
    const beforeValue = timecard.punches.map(punch => punch.toObject());
    const request = await db.changeRequest.create({ referenceId: timecard._id, targetField: 'timecard.punches',
        beforeValue, afterValue: beforeValue.map((punch, index) => index ? { ...punch, time: new Date('2026-09-11T20:30:00Z') } : punch),
        baseHash: timecard.currentHash, reason: 'Correct clock out', submittedBy: submitter._id });
    const handlers = {};
    evaluate('socket/event/changeRequest.js', { '../../models': db,
        '../session': { getSessionUserId: () => actor._id, resolveUserPermissions: async user => user,
            hasPermission: user => user.role === 'Admin' || user.role === 'Manager' },
        '../../utils/changeRequestHandlers': evaluate('utils/changeRequestHandlers.js', { '../models': db }),
    })({ on: (event, handler) => { handlers[event] = handler; } });
    commands.length = 0;
    return { db, commands, actor, submitter, timecard, request, close,
        call: async (event = 'changeRequest:approve', input = {}) => {
            let result;
            await handlers[event]({ _id: request._id, ...input }, response => { result = response; });
            return result;
        },
    };
};

module.exports = { timecardApprovalFixture };
