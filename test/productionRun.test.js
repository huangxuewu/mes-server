const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const mongoose = require('mongoose');
const dayjs = require('dayjs');
dayjs.extend(require('dayjs/plugin/utc'));
dayjs.extend(require('dayjs/plugin/timezone'));

const load = (file, dependencies) => {
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), {
        module, exports: module.exports, console, Date,
        require: name => {
            if (!(name in dependencies)) throw new Error(`Unexpected dependency: ${name}`);
            return dependencies[name];
        },
    });
    return module.exports;
};

test('production run schema protects open lines and retains audit events', async t => {
    const connection = mongoose.createConnection();
    connection.config.autoCreate = false;
    connection.config.autoIndex = false;
    t.after(() => connection.destroy());
    const database = { model: (...args) => {
        const model = connection.model(...args);
        model.watch = () => new EventEmitter();
        return model;
    } };
    const Run = load('models/productionRun.js', { mongoose, '../config/database': database, '../socket/io': { io: {} } });
    const indexes = Run.schema.indexes();
    assert.ok(indexes.some(([fields, options]) => fields.lineId === 1 && options.unique && options.partialFilterExpression.open === true));
    assert.ok(indexes.some(([fields, options]) => fields.startRequestId && options.unique));
    assert.ok(indexes.some(([fields, options]) => fields['lots.number'] && options.unique));
    const run = new Run({ status: 'Unknown' });
    assert.ok(run.validateSync().errors.status);
    assert.ok(run.validateSync().errors.startedAt);
});

const uri = process.env.PRODUCTION_RUN_TEST_URI;
test('production run lifecycle against an isolated replica set', { skip: !uri }, async t => {
    // Never import the application database configuration or connect to a remote database.
    assert.match(uri, /^mongodb:\/\/(127\.0\.0\.1|localhost):\d+\/production_run_test_[a-z\d_]+(?:\?|$)/i);
    const connection = await mongoose.createConnection(uri).asPromise();
    t.after(() => connection.close());
    const database = { connection, model: (...args) => {
        const model = connection.model(...args);
        model.watch = () => new EventEmitter();
        return model;
    } };
    const db = {};
    for (const name of ['line', 'productionRun', 'counter', 'pallet']) db[name] = load(`models/${name}.js`, { mongoose, '../config/database': database, '../socket/io': { io: {} } });
    db.product = connection.model('product', new mongoose.Schema({ styleName: String, styleCode: String, status: String, packaging: { boxesPerPallet: Number, bagsPerBox: Number, pillowsPerBag: Number } }));
    db.parameter = connection.model('Parameter', new mongoose.Schema({ lineId: mongoose.Schema.Types.ObjectId, name: String, settings: [{ key: String, value: String }] }));
    db.productionSchedule = load('models/productionSchedule.js', { mongoose, '../config/database': database });
    db.department = load('models/department.js', { mongoose, '../config/database': database, '../socket/io': { io: {} } });
    db.employee = connection.model('employee', new mongoose.Schema({ firstName: String, lastName: String, portrait: String, pin: String, isDeleted: Boolean, hiringStatus: String, employment: { status: String } }));
    await Promise.all(Object.values(db).map(model => model.init()));
    const line = await db.line.create({ name: 'Test line', description: 'Isolated integration fixture' });
    const otherLine = await db.line.create({ name: 'Other line', description: 'Isolated integration fixture' });
    const product = await db.product.create({ styleName: 'Test pillow', styleCode: 'TEST-001', status: 'Active', packaging: { boxesPerPallet: 24, bagsPerBox: 6, pillowsPerBag: 2 } });
    const profile = await db.parameter.create({ lineId: line._id, name: 'Test recipe', settings: [{ key: 'speed', value: '0' }] });
    const otherProfile = await db.parameter.create({ lineId: otherLine._id, name: 'Other recipe', settings: [] });
    const staff = await db.employee.create([{ firstName: 'Ava', lastName: 'Test', hiringStatus: 'Active', employment: { status: 'Active' }, pin: 'private-pin' }, { firstName: 'Ben', lastName: 'Test', hiringStatus: 'Active', employment: { status: 'Active' } }]);
    for (const machine of [line, otherLine]) { machine.steps = [{ name: 'Packing', sequence: 0, qualifiedWorkers: staff.map(person => person._id) }]; await machine.save(); }
    const department = await db.department.create({ name: 'Test department', teams: [{ name: 'Day team', members: staff.map(person => person._id) }] });
    const schedule = { date: dayjs().tz('America/New_York').format('YYYY-MM-DD'), departmentId: String(department._id), teamId: String(department.teams[0]._id) };
    await db.productionSchedule.create({ date: schedule.date, assignments: [{ departmentId: department._id, teamId: department.teams[0]._id, styleCode: product.styleCode, quantity: 1000 }] });
    const crewFor = machine => [{ stepId: String(machine.steps[0]._id), slotIndex: 0, employeeId: String(staff[0]._id), enabled: true }, { stepId: String(machine.steps[0]._id), slotIndex: 1, employeeId: null, enabled: false }];
    let user = { _id: new mongoose.Types.ObjectId(), role: 'Admin' };
    const handlers = {};
    const socket = { on: (event, handler) => { handlers[event] = handler; } };
    load('socket/event/productionRun.js', {
        '../../models': db, '../../config/database': database,
        '../../utils/dayjs': Object.assign(dayjs, { getFactoryTimeZone: async () => 'America/New_York' }),
        '../session': { getActiveSessionUser: async () => {
            if (!user) throw Error('Sign in to continue');
            return user;
        }, hasPermission: require('../socket/session').hasPermission },
    })(socket);
    const call = (action, payload) => new Promise(resolve => handlers[action](payload, resolve));
    let sequence = 0;
    const requestId = () => `test-request-${String(++sequence).padStart(8, '0')}`;
    const start = (overrides = {}) => ({ lineId: String(line._id), productId: String(product._id), profileId: String(profile._id), schedule: { ...schedule }, crew: crewFor(line), requestId: requestId(), ...overrides });
    let run;
    const actionPayload = (overrides = {}) => ({ reason: 'Production completed', stopType: 'Scheduled', lineId: String(line._id), runId: String(run._id), revision: run.revision, requestId: requestId(), ...overrides });

    await t.test('setup uses today schedule and returns only safe employee fields', async () => {
        const response = await call('productionRun:setup', { lineId: String(line._id) });
        assert.equal(response.status, 'success');
        assert.equal(response.payload.date, schedule.date);
        assert.equal(response.payload.assignments[0].teamName, 'Day team');
        assert.equal(response.payload.profiles.length, 1);
        assert.equal(response.payload.employees[0].pin, undefined);
    });

    await t.test('start rejects unscheduled work and invalid or duplicate staffing before any run is saved', async () => {
        assert.equal((await call('productionRun:start', start({ schedule: { ...schedule, date: '2000-01-01' } }))).message, 'productionRun.errors.schedule');
        assert.equal((await call('productionRun:start', start({ schedule: { ...schedule, teamId: String(new mongoose.Types.ObjectId()) } }))).message, 'productionRun.errors.schedule');
        assert.equal((await call('productionRun:start', start({ crew: [] }))).message, 'productionRun.errors.crew');
        const crew = crewFor(line); crew[1] = { ...crew[1], employeeId: crew[0].employeeId, enabled: true };
        assert.equal((await call('productionRun:start', start({ crew }))).message, 'productionRun.errors.crew');
        await db.employee.updateOne({ _id: staff[0]._id }, { $set: { 'employment.status': 'Terminated' } });
        assert.equal((await call('productionRun:start', start())).message, 'productionRun.errors.crew');
        await db.employee.updateOne({ _id: staff[0]._id }, { $set: { 'employment.status': 'Active' } });
        assert.equal(await db.productionRun.countDocuments(), 0);
    });

    await t.test('requires permissions and validates product and profile', async () => {
        const original = user;
        user = { _id: original._id, permission: {} };
        assert.equal((await call('productionRun:start', start())).message, 'productionRun.errors.permission');
        user = null;
        assert.equal((await call('productionRuns:get', { lineId: String(line._id) })).status, 'error');
        user = original;
        assert.equal((await call('productionRun:start', start({ productId: 'bad' }))).message, 'productionRun.errors.product');
        assert.equal((await call('productionRun:start', start({ lineId: String(otherLine._id) }))).message, 'productionRun.errors.profile');
        for (const settings of [{ speed: '5' }, [{ key: 'unknown', value: '5' }], [{ key: 'speed', value: 5 }], [{ key: 'speed', value: '5' }, { key: 'speed', value: '6' }]]) {
            assert.equal((await call('productionRun:start', start({ settings }))).message, 'productionRun.errors.profile');
        }
        assert.equal(await db.productionRun.countDocuments(), 0);
    });

    await t.test('concurrent starts commit one run and retries return the same run', async () => {
        const requests = [start({ settings: [{ key: 'speed', value: '25' }] }), start({ settings: [{ key: 'speed', value: '25' }] })];
        const results = await Promise.all(requests.map(payload => call('productionRun:start', payload)));
        assert.equal(results.filter(result => result.status === 'success').length, 1);
        const index = results.findIndex(result => result.status === 'success');
        run = results[index].payload.run;
        assert.equal(await db.productionRun.countDocuments({ open: true }), 1);
        assert.equal((await db.line.findById(line._id)).status.code, 100);
        assert.equal(run.settings[0].value, '25');
        assert.equal((await db.parameter.findById(profile._id)).settings[0].value, '0');
        assert.equal(run.packaging.boxesPerPallet, 24);
        assert.equal(run.crew[0].employeeName, 'Ava Test');
        assert.equal(run.crew[1].enabled, false);
        assert.equal(run.schedule.quantity, 1000);
        const retry = await call('productionRun:start', requests[index]);
        assert.equal(String(retry.payload.run._id), String(run._id));
        assert.equal(retry.payload.run.events.length, 1);
        const mismatch = await call('productionRun:start', { ...requests[index], profileId: null });
        assert.equal(mismatch.message, 'productionRun.errors.request');
        assert.equal((await call('productionRun:start', { ...requests[index], settings: [{ key: 'speed', value: '26' }] })).message, 'productionRun.errors.request');
        const changedCrew = crewFor(line); changedCrew[0].employeeId = String(staff[1]._id);
        assert.equal((await call('productionRun:start', { ...requests[index], crew: changedCrew })).message, 'productionRun.errors.request');
    });

    await t.test('pause requires reason; immutable events use server time and authenticated actor', async () => {
        assert.equal((await call('productionRun:pause', actionPayload({ reason: '' }))).message, 'productionRun.errors.stopReason');
        const payload = actionPayload({ reason: 'Material shortage', statusCode: 120, by: new mongoose.Types.ObjectId(), at: '1990-01-01' });
        run = (await call('productionRun:pause', payload)).payload.run;
        assert.equal(run.status, 'Paused');
        assert.equal(run.open, true);
        assert.equal(String(run.events[1].by), String(user._id));
        assert.ok(run.events[1].at >= run.startedAt);
        assert.equal((await db.line.findById(line._id)).status.code, 120);
        const replay = await call('productionRun:pause', payload);
        assert.equal(replay.payload.run.events.length, 2);
        assert.equal((await call('productionRun:pause', { ...payload, reason: 'Changed' })).message, 'productionRun.errors.request');
    });

    await t.test('stale transition cannot overwrite a newer action; snapshots survive master-data changes', async () => {
        const stale = actionPayload();
        run = (await call('productionRun:resume', actionPayload())).payload.run;
        assert.equal((await call('productionRun:end', stale)).message, 'productionRun.errors.stale');
        await db.product.updateOne({ _id: product._id }, { $set: { 'packaging.boxesPerPallet': 99 } });
        assert.equal((await db.productionRun.findById(run._id)).packaging.boxesPerPallet, 24);
    });

    await t.test('failure updating line status rolls back the entire transition', async () => {
        const update = db.line.updateOne;
        db.line.updateOne = () => { throw Error('Injected write failure'); };
        try {
            assert.equal((await call('productionRun:pause', actionPayload({ reason: 'Test rollback' }))).status, 'error');
        } finally { db.line.updateOne = update; }
        assert.equal((await db.productionRun.findById(run._id)).status, 'Running');
        assert.equal((await db.productionRun.findById(run._id)).events.length, 3);
        assert.equal((await db.line.findById(line._id)).status.code, 100);
    });

    await t.test('ending a paused run closes its window and permits the next product run', async () => {
        run = (await call('productionRun:pause', actionPayload({ reason: 'Break', statusCode: 210 }))).payload.run;
        const endPayload = actionPayload();
        run = (await call('productionRun:end', endPayload)).payload.run;
        assert.equal(run.open, false);
        assert.equal(run.status, 'Ended');
        assert.ok(run.endedAt >= run.startedAt);
        assert.equal((await call('productionRun:end', endPayload)).payload.run.events.length, 5);
        assert.equal((await call('productionRun:resume', actionPayload())).message, 'productionRun.errors.transition');
        const next = await call('productionRun:start', start());
        assert.equal(next.status, 'success');
        assert.equal(next.payload.run.settings[0].value, '0');
        assert.notEqual(String(next.payload.run._id), String(run._id));
        const history = await call('productionRuns:get', { lineId: String(line._id) });
        assert.equal(history.payload.runs.length, 2);
        assert.equal(history.payload.runs.filter(item => item.open).length, 1);
    });

    await t.test('different lines can produce the same product independently', async () => {
        const result = await call('productionRun:start', start({ lineId: String(otherLine._id), profileId: String(otherProfile._id), crew: crewFor(otherLine) }));
        assert.equal(result.status, 'success');
        assert.equal(await db.productionRun.countDocuments({ open: true }), 2);
    });

    await t.test('ordinary line edits cannot overwrite production status or its concurrency revision', async () => {
        load('socket/event/line.js', { '../../models': db, mongoose, '../session': { getActiveSessionUser: async () => user, hasPermission: require('../socket/session').hasPermission } })(socket);
        const before = await db.line.findById(line._id);
        const result = await call('line:update', {
            _id: String(line._id), description: 'Updated line description', steps: [],
            status: { code: 900 }, productionRevision: 0, 'status.code': 910,
        });
        assert.equal(result.status, 'success');
        const after = await db.line.findById(line._id);
        assert.equal(after.status.code, before.status.code);
        assert.equal(after.productionRevision, before.productionRevision);
        assert.equal(after.description, 'Updated line description');
    });
    await t.test('main and backup configuration, LOT history, crew changes, issues and pallet traceability stay consistent', async () => {
        const machine = await db.line.create({ name: 'LOT trace line', description: 'Isolated LOT test', steps: [{ name: 'Packing', qualifiedWorkers: [staff[0]._id] }] });
        const machineProfile = await db.parameter.create({ lineId: machine._id, name: 'Trace settings', settings: [{ key: 'speed', value: '50' }] });
        const step = machine.steps[0].toObject();
        const manager = user; user = { _id: manager._id, role: 'User', permission: {} };
        assert.equal((await call('line:update', { _id: String(machine._id), steps: [] })).message, 'productionRun.errors.permission');
        user = manager;
        assert.equal(step.mainWorkers, undefined, 'legacy assignments remain available as defaults');
        const saved = await call('line:update', { _id: String(machine._id), steps: [{ ...step, mainWorkers: [String(staff[0]._id)], backupWorkers: [String(staff[1]._id)] }] });
        assert.equal(saved.status, 'success');
        assert.equal(saved.payload.steps[0].qualifiedWorkers.length, 1, 'backups do not increase staffing');
        assert.equal(String(saved.payload.steps[0].backupWorkers[0]), String(staff[1]._id));
        assert.equal((await call('line:update', { _id: String(machine._id), steps: [{ ...step, mainWorkers: [String(staff[0]._id)], backupWorkers: [String(staff[0]._id)] }] })).message, 'productionStart.invalidWorkers');
        const crew = [{ stepId: String(step._id), slotIndex: 0, enabled: true, employeeId: String(staff[0]._id) }];
        const startPayload = start({ lineId: String(machine._id), profileId: String(machineProfile._id), crew });
        let traceRun = (await call('productionRun:start', startPayload)).payload.run;
        const firstLot = traceRun.lotNumber;
        assert.match(firstLot, /^L[0-9A-Z]{8}$/);
        assert.equal(traceRun.lots.length, 1);
        assert.equal(traceRun.lots[0].crew[0].employeeName, 'Ava Test');
        const command = extra => ({ lineId: String(machine._id), runId: String(traceRun._id), revision: traceRun.revision, requestId: requestId(), ...extra });
        const issuePayload = command({ issueType: 'Machine', reason: 'Needle vibration' });
        traceRun = (await call('productionRun:issue', issuePayload)).payload.run;
        assert.equal(traceRun.status, 'Running');
        assert.equal(traceRun.lotNumber, firstLot);
        assert.equal(traceRun.events.at(-1).reason, 'Needle vibration');
        assert.equal((await call('productionRun:issue', issuePayload)).payload.run.events.length, 2);
        assert.equal((await call('productionRun:issue', { ...issuePayload, reason: 'Changed' })).message, 'productionRun.errors.request');
        traceRun = (await call('productionRun:issue', command({ issueType: 'Employee', employeeId: String(staff[0]._id), reason: 'Needs assistance with packing' }))).payload.run;
        assert.equal(traceRun.events.at(-1).employeeName, 'Ava Test');
        assert.equal((await call('productionRun:issue', command({ issueType: 'Employee', employeeId: String(staff[1]._id), reason: 'Not on crew' }))).message, 'productionRun.errors.issue');
        for (const stop of ['pause', 'end']) {
            assert.equal((await call(`productionRun:${stop}`, command({ reason: '' }))).message, 'productionRun.errors.stopReason');
            assert.equal((await call(`productionRun:${stop}`, command({ reason: 'Reason but no classification' }))).message, 'productionRun.errors.stopReason');
        }
        load('socket/event/productionPallet.js', {
            '../../models': db, '../../config/database': database, '../../utils/dayjs': dayjs,
            '../../utils/productionMetrics': require('../utils/productionMetrics'),
            '../../utils/productionPalletActions': require('../utils/productionPalletActions'),
            '../session': { getActiveSessionUser: async () => user, hasPermission: require('../socket/session').hasPermission },
        })(socket);
        const register = { lineId: String(machine._id), runId: String(traceRun._id), lotNumber: firstLot, boxes: 2, requestId: requestId() };
        const firstPallet = (await call('pallet:register', register)).payload;
        assert.equal(firstPallet.lotNumber, firstLot);
        traceRun = (await call('productionRun:pause', command({ reason: 'Repair vibration', statusCode: 310, stopType: 'Unscheduled' }))).payload.run;
        const stoppedAt = (await db.line.findById(machine._id)).status.updatedAt.getTime();
        assert.equal(traceRun.events.at(-1).stopType, 'Unscheduled');
        assert.equal((await call('productionRun:changeCrew', command({ reason: 'No change', crew }))).message, 'productionRun.errors.unchangedCrew');
        const newCrew = [{ ...crew[0], employeeId: String(staff[1]._id) }];
        const crewPayload = command({ reason: 'Backup replaces main', crew: newCrew });
        traceRun = (await call('productionRun:changeCrew', crewPayload)).payload.run;
        assert.notEqual(traceRun.lotNumber, firstLot);
        assert.equal(traceRun.status, 'Paused');
        assert.equal((await db.line.findById(machine._id)).status.updatedAt.getTime(), stoppedAt);
        assert.equal(traceRun.lots[0].endedAt.getTime(), traceRun.lots[1].startedAt.getTime());
        assert.equal(traceRun.lots[0].crew[0].employeeName, 'Ava Test');
        assert.equal(traceRun.lots[1].crew[0].employeeName, 'Ben Test');
        assert.equal((await call('productionRun:changeCrew', crewPayload)).payload.run.lots.length, 2);
        assert.equal((await call('productionRun:changeCrew', { ...crewPayload, crew })).message, 'productionRun.errors.request');
        assert.equal((await call('productionRun:start', startPayload)).payload.run.lotNumber, traceRun.lotNumber, 'start retries still identify the original crew after changes');
        assert.equal((await call('pallet:register', { ...register, requestId: requestId() })).message, 'productionPallet.errors.lotChanged');
        assert.equal((await call('pallet:register', register)).payload._id, firstPallet._id, 'a saved pallet retains its original LOT when retried');
        const newPallet = (await call('pallet:register', { ...register, requestId: requestId(), lotNumber: traceRun.lotNumber })).payload;
        assert.equal(newPallet.lotNumber, traceRun.lotNumber);
        const secondLot = traceRun.lotNumber;
        traceRun = (await call('productionRun:resume', command({}))).payload.run;
        assert.equal(traceRun.lotNumber, secondLot);
        traceRun = (await call('productionRun:end', command({ reason: 'Daily plan completed', stopType: 'Scheduled' }))).payload.run;
        assert.equal(traceRun.lots.at(-1).endedAt.getTime(), traceRun.endedAt.getTime());
        assert.equal(traceRun.events.at(-1).stopType, 'Scheduled');
        await db.parameter.updateOne({ _id: machineProfile._id }, { $set: { 'settings.0.value': '99' } });
        const trace = (await call('productionLot:get', { query: firstPallet._id })).payload;
        assert.equal(trace.lot.number, firstLot);
        assert.equal(trace.run.settings[0].value, '50');
        assert.equal(trace.pallets.length, 1);
        assert.equal(trace.pallets[0].boxesPerPallet, 2);
        assert.equal((await call('productionLot:get', { query: secondLot.toLowerCase() })).payload.lot.crew[0].employeeName, 'Ben Test');
        assert.equal((await call('productionLot:get', { query: 'LUNKNOWN' })).message, 'productionRun.errors.lot');
    });

    await t.test('concurrent starts on different lines allocate distinct short LOT numbers', async () => {
        const fixtures = await Promise.all(['C', 'D'].map(async name => {
            const machine = await db.line.create({ name, description: 'Concurrent LOT fixture', steps: [{ name: 'Packing', mainWorkers: [staff[0]._id], backupWorkers: [staff[1]._id] }] });
            const profile = await db.parameter.create({ name: 'Concurrent profile', lineId: machine._id, settings: [] });
            return start({ lineId: String(machine._id), profileId: String(profile._id), crew: [{ stepId: String(machine.steps[0]._id), slotIndex: 0, employeeId: String(staff[0]._id), enabled: true }] });
        }));
        const results = await Promise.all(fixtures.map(payload => call('productionRun:start', payload)));
        for (const result of results) assert.equal(result.status, 'success', result.message);
        assert.notEqual(results[0].payload.run.lotNumber, results[1].payload.run.lotNumber);
    });

    await t.test('unavailable employees can be excluded while active crew eligibility and LOT history remain enforced', async () => {
        const machine = await db.line.create({ name: 'Crew exclusion line', description: 'Isolated regression', steps: [{ name: 'Packing', mainWorkers: staff.map(person => person._id) }] });
        const machineProfile = await db.parameter.create({ lineId: machine._id, name: 'Crew exclusion settings', settings: [] });
        const crew = staff.map((person, slotIndex) => ({ stepId: String(machine.steps[0]._id), slotIndex, employeeId: String(person._id), enabled: true }));
        let result = await call('productionRun:start', start({ lineId: String(machine._id), profileId: String(machineProfile._id), crew }));
        assert.equal(result.status, 'success', result.message);
        const original = result.payload.run;
        const payload = { lineId: String(machine._id), runId: String(original._id), revision: original.revision, requestId: requestId(), reason: 'Employee leaves the crew', crew: crew.map((slot, index) => ({ ...slot, enabled: index === 1 })) };
        try {
            await db.employee.updateOne({ _id: staff[0]._id }, { $set: { 'employment.status': 'On Leave' } });
            result = await call('productionRun:changeCrew', payload);
            assert.equal(result.status, 'success', result.message);
            const changed = result.payload.run;
            assert.equal(changed.crew[0].enabled, false);
            assert.equal(String(changed.crew[0].employeeId), String(staff[0]._id));
            assert.equal(changed.crew[0].employeeName, 'Ava Test');
            assert.equal(changed.lots[0].crew[0].enabled, true);
            assert.equal(changed.lots[0].crew[0].employeeName, 'Ava Test');
            assert.equal(changed.lots.length, 2);
            assert.equal((await call('productionRun:changeCrew', payload)).payload.run.lots.length, 2);
            for (const status of ['On Leave', 'Inactive', 'Terminated']) {
                await db.employee.updateOne({ _id: staff[0]._id }, { $set: { 'employment.status': status } });
                assert.equal((await call('productionRun:changeCrew', { ...payload, revision: changed.revision, requestId: requestId(), crew })).message, 'productionRun.errors.crew');
            }
        } finally {
            await db.employee.updateOne({ _id: staff[0]._id }, { $set: { 'employment.status': 'Active' } });
        }
    });

});
