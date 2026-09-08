const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const test = require('node:test');
const { auditProductionReadiness } = require('../scripts/audit-production-readiness');
const mongoose = require('mongoose');
const dayjs = require('dayjs');
dayjs.extend(require('dayjs/plugin/utc'));
dayjs.extend(require('dayjs/plugin/timezone'));

const load = (file, dependencies) => {
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), {
        module, exports: module.exports, console, Date,
        require: name => {
            if (!(name in dependencies)) throw Error(`Unexpected dependency ${name}`);
            return dependencies[name];
        },
    });
    return module.exports;
};

const uri = process.env.PRODUCTION_PALLET_TEST_URI;
test('pallet registration, printing and stock-in against isolated replica set', { skip: !uri }, async t => {
    assert.match(uri, /^mongodb:\/\/(127\.0\.0\.1|localhost):\d+\/production_pallet_test_[a-z\d_]+(?:\?|$)/i);
    const connection = await mongoose.createConnection(uri).asPromise();
    t.after(() => connection.close());
    const database = { connection, model: (...args) => {
        const model = connection.model(...args);
        model.watch = () => new EventEmitter();
        return model;
    } };
    const db = {};
    for (const name of ['line', 'product', 'parameter', 'productionRun', 'productionSchedule', 'department', 'pallet', 'counter', 'storage', 'finishedGoods']) {
        db[name] = load(`models/${name}.js`, { mongoose, '../config/database': database, '../socket/io': { io: {} } });
    }
    db.employee = connection.model('employee', new mongoose.Schema({ firstName: String, pin: String, isDeleted: Boolean, hiringStatus: String, employment: { status: String } }));
    await Promise.all(Object.values(db).map(model => model.init()));
    const handlers = {};
    let user = { _id: new mongoose.Types.ObjectId(), role: 'Admin', displayName: 'Test manager' };
    const socket = { on: (event, handler) => { handlers[event] = handler; } };
    const dependencies = { '../../models': db, '../../config/database': database,
        '../../utils/productionMetrics': require('../utils/productionMetrics'),
            '../../utils/productionPalletActions': require('../utils/productionPalletActions'),
        '../../utils/dayjs': Object.assign(dayjs, { getFactoryTimeZone: async () => 'America/New_York' }),
        '../session': { getActiveSessionUser: async () => {
            if (!user) throw Error('Sign in to continue');
            return user;
        }, hasPermission: require('../socket/session').hasPermission },
    };
    for (const event of ['productionRun', 'productionPallet', 'productionHealth', 'storage', 'pallet']) load(`socket/event/${event}.js`, dependencies)(socket);
    const call = (event, payload) => new Promise(resolve => handlers[event](payload, resolve));
    const success = async (event, payload) => {
        const response = await call(event, payload);
        assert.equal(response.status, 'success', response.message);
        return response.payload;
    };
    const product = await db.product.create({ styleName: 'Pillow', description: 'Test pillow', styleCode: '062021234', letterCode: 'A', status: 'Active', packaging: { boxesPerPallet: 24, bagsPerBox: 6, pillowsPerBag: 2 } });
    const lines = await db.line.create([{ name: 'A', description: 'Test A' }, { name: 'B', description: 'Test B' }]);
    const runs = [];
    const employee = await db.employee.create({ firstName: 'Packer', hiringStatus: 'Active', employment: { status: 'Active' } });
    const department = await db.department.create({ name: 'Packing', teams: [{ name: 'Day', members: [employee._id] }] });
    const schedule = { date: dayjs().tz('America/New_York').format('YYYY-MM-DD'), departmentId: String(department._id), teamId: String(department.teams[0]._id) };
    await db.productionSchedule.create({ date: schedule.date, assignments: [{ ...schedule, styleCode: product.styleCode, quantity: 1000 }] });
    for (const line of lines) {
        line.steps = [{ name: 'Packing', qualifiedWorkers: [employee._id] }]; await line.save();
        const profile = await db.parameter.create({ lineId: line._id, name: 'Packing profile', settings: [] });
        const crew = [{ stepId: String(line.steps[0]._id), slotIndex: 0, employeeId: String(employee._id), enabled: true }];
        runs.push((await success('productionRun:start', { lineId: String(line._id), productId: String(product._id), profileId: String(profile._id), schedule, crew, requestId: randomUUID() })).run);
    }
    const registration = (index = 0, boxes = 24) => ({ lineId: String(lines[index]._id), runId: String(runs[index]._id), lotNumber: runs[index].lotNumber, requestId: randomUUID(), boxes });
    const transition = (index, extra = {}) => ({ reason: 'Production completed', stopType: 'Scheduled', lineId: String(lines[index]._id), runId: String(runs[index]._id), revision: runs[index].revision, requestId: randomUUID(), ...extra });
    const context = index => success('productionPallets:get', { lineId: String(lines[index]._id) });
    let full, partial;

    await t.test('full and partial pallets use run snapshots and server registration time', async () => {
        await db.product.updateOne({ _id: product._id }, { $set: { 'packaging.bagsPerBox': 99 } });
        full = await success('pallet:register', { ...registration(), productId: String(new mongoose.Types.ObjectId()), quantity: 99999, registeredAt: '1999-01-01', date: '1999-01-01' });
        partial = await success('pallet:register', registration(0, 5));
        assert.equal(full.quantity, 288); assert.equal(partial.quantity, 60);
        assert.equal(full.bagsPerBox, 6); assert.equal(String(full.productId), String(product._id));
        assert.ok(full.registeredAt >= runs[0].startedAt);
        assert.equal(full.printedAt, null);
        assert.equal(full.status, 'Pending');
        assert.match(full._id, /^1234-\d{6}-\d{4}-\d{3,}$/);
        assert.equal(await db.finishedGoods.countDocuments(), 0);
        assert.equal(await db.storage.countDocuments(), 0);
        const { totals } = await context(0);
        assert.equal(totals.pallets, 2); assert.equal(totals.boxes, 29); assert.equal(totals.pillows, 348);
    });

    await t.test('same request sent concurrently registers exactly once and mismatched retries fail', async () => {
        const request = registration();
        const [first, second] = await Promise.all([success('pallet:register', request), success('pallet:register', request)]);
        assert.equal(first._id, second._id);
        assert.equal(await db.pallet.countDocuments({ registrationRequestId: request.requestId }), 1);
        assert.equal((await call('pallet:register', { ...request, boxes: 3 })).message, 'productionPallet.errors.request');
        assert.equal((await context(0)).totals.pallets, 3);
    });

    await t.test('same product on separate lines has separate totals and unique labels', async () => {
        const pallet = await success('pallet:register', registration(1, 2));
        assert.notEqual(pallet._id, full._id);
        assert.equal((await context(1)).totals.pillows, 24);
        assert.equal((await context(0)).totals.pallets, 3);
    });

    await t.test('paused runs accept packing; ended runs reject new output but acknowledge old registration retries', async () => {
        runs[0] = (await success('productionRun:pause', transition(0, { reason: 'Break', statusCode: 210 }))).run;
        const request = registration(0, 1);
        const pallet = await success('pallet:register', request);
        runs[0] = (await success('productionRun:end', transition(0))).run;
        assert.equal((await call('pallet:register', registration())).message, 'productionPallet.errors.run');
        const retry = await success('pallet:register', request);
        assert.equal(retry._id, pallet._id);
        assert.equal(retry.registeredAt.getTime(), pallet.registeredAt.getTime());
    });

    await t.test('print failure and reprint retain output count, quantity and timestamp after run end', async () => {
        const original = (await context(0)).totals.pillows;
        const failedRequest = { palletId: full._id, requestId: randomUUID(), printer: 'Test printer' };
        await success('pallet:preparePrint', failedRequest);
        const failed = await success('pallet:printResult', { ...failedRequest, result: 'Failed' });
        assert.equal(failed.printedAt, null);
        const request = { ...failedRequest, requestId: randomUUID() };
        await success('pallet:preparePrint', request);
        await success('pallet:preparePrint', request);
        await success('pallet:printResult', { ...request, result: 'Submitted' });
        const repeated = await success('pallet:printResult', { ...request, result: 'Submitted' });
        assert.equal(repeated.printAttempts.length, 2);
        assert.equal(repeated.registeredAt.getTime(), full.registeredAt.getTime());
        assert.equal((await context(0)).totals.pillows, original);
    });

    await t.test('storing changes location without counting stock; simultaneous putaway increments once', async () => {
        await success('pallet:store', { palletId: full._id, location: { zone: 'Bay 1' } });
        await success('pallet:store', { palletId: full._id, location: { zone: 'Bay 2' } });
        assert.equal(await db.storage.countDocuments({ batchNumber: full._id }), 1);
        assert.equal(await db.finishedGoods.countDocuments(), 0);
        await Promise.all([success('pallet:putaway', { palletId: full._id }), success('pallet:putaway', { palletId: full._id })]);
        const goods = await db.finishedGoods.findOne({ productId: product._id });
        assert.equal(goods.totalQuantity, 288); assert.equal(goods.availableQuantity, 288);
        const storage = await db.storage.findOne({ batchNumber: full._id });
        assert.equal(String(storage.contents[0].inventoryId), String(goods._id));
        assert.equal((await db.pallet.findById(full._id)).status, 'Putaway');
        assert.equal((await call('pallet:void', { palletId: full._id, reason: 'Not allowed' })).message, 'productionPallet.errors.putaway');
    });

    await t.test('invalid location rolls back stock and pallet state together', async () => {
        const before = (await db.finishedGoods.findOne({ productId: product._id })).totalQuantity;
        assert.equal((await call('pallet:putaway', { palletId: partial._id, location: { zone: 'Invalid' } })).status, 'error');
        assert.equal((await db.finishedGoods.findOne({ productId: product._id })).totalQuantity, before);
        assert.equal((await db.pallet.findById(partial._id)).status, 'Pending');
        assert.equal(await db.storage.countDocuments({ batchNumber: partial._id }), 0);
    });

    await t.test('void removes output and pending storage and blocks printing/putaway', async () => {
        const before = (await context(0)).totals.pillows;
        await success('pallet:store', { palletId: partial._id, location: { zone: 'Bay 1' } });
        await success('pallet:void', { palletId: partial._id, reason: 'Wrong physical quantity' });
        await success('pallet:void', { palletId: partial._id, reason: 'Retry' });
        assert.equal(await db.storage.countDocuments({ batchNumber: partial._id }), 0);
        assert.equal((await context(0)).totals.pillows, before - 60);
        assert.equal((await call('pallet:putaway', { palletId: partial._id, location: { zone: 'Bay 1' } })).status, 'error');
        assert.equal((await call('pallet:preparePrint', { palletId: partial._id, requestId: randomUUID(), printer: 'Test' })).status, 'error');
    });

    await t.test('concurrent distinct pallets add stock without losing increments or creating duplicate stock records', async () => {
        const first = await success('pallet:register', registration(1, 1));
        const second = await success('pallet:register', registration(1, 2));
        const before = (await db.finishedGoods.findOne({ productId: product._id })).totalQuantity;
        await Promise.all([first, second].map(pallet => success('pallet:putaway', { palletId: pallet._id, location: { zone: 'Bay 3' } })));
        assert.equal(await db.finishedGoods.countDocuments({ productId: product._id }), 1);
        assert.equal((await db.finishedGoods.findOne({ productId: product._id })).totalQuantity, before + 36);
    });

    await t.test('end versus register race yields only output registered before end', async () => {
        const [registrationResult] = await Promise.all([
            call('pallet:register', registration(1, 1)),
            success('productionRun:end', transition(1)),
        ]);
        const ended = await db.productionRun.findById(runs[1]._id);
        if (registrationResult.status === 'success') assert.ok(registrationResult.payload.registeredAt <= ended.endedAt);
        else assert.equal(registrationResult.message, 'productionPallet.errors.run');
    });

    await t.test('legacy pallets remain usable and unrestricted legacy mutations cannot bypass registration', async () => {
        const legacy = await db.pallet.create({ _id: 'LEGACY-001', productId: product._id, styleCode: product.styleCode, boxesPerPallet: 1, bagsPerBox: 6, pillowsPerBag: 2 });
        await db.pallet.create({ _id: 'LEGACY-002', productId: product._id, boxesPerPallet: 1, bagsPerBox: 6, pillowsPerBag: 2 });
        assert.equal((await success('pallet:putaway', { palletId: legacy._id, location: { zone: 'Bay 4' } })).status, 'Putaway');
        for (const event of ['create', 'update', 'delete', 'reserve']) assert.equal((await call('pallet:' + event, { _id: full._id })).message, 'productionPallet.errors.legacy');
    });

    await t.test('health totals match registration, exclude voids and legacy pallets, and distinguish stock-in', async () => {
        const idle = await db.line.create({ name: 'Idle', description: 'Never started' });
        const health = await success('productionHealth:get', {});
        assert.equal(health.items.length, 3);
        const untouched = health.items.find(item => String(item.line._id) === String(idle._id));
        assert.equal(untouched.run, null);
        assert.equal(untouched.rates.overall, null);
        for (let index = 0; index < 2; index++) {
            const item = health.items.find(item => String(item.line._id) === String(lines[index]._id));
            const expected = await context(index);
            assert.equal(item.totals.pillows, expected.totals.pillows);
            assert.equal(item.totals.awaitingPutaway, expected.totals.awaitingPutaway);
            assert.equal(item.buckets.reduce((sum, bucket) => sum + bucket.pillows, 0), item.totals.pillows);
            assert.ok(Number.isFinite(item.rates.overall));
            assert.equal(item.times.elapsed, item.times.running + item.times.paused);
            assert.equal(item.run.status, 'Ended');
        }
    });

    await t.test('readiness audit verifies real indexes and reports duplicates without changing database state', async () => {
        const ready = await auditProductionReadiness(connection.db);
        assert.equal(ready.databaseChecksPassed, true);
        assert.equal(ready.topologySupported, true);
        const scratch = connection.getClient().db(connection.name + '_preflight');
        await scratch.collection('productionRun').insertMany([
            { lineId: 'duplicate-line', startRequestId: 'duplicate-request', open: true },
            { lineId: 'duplicate-line', startRequestId: 'duplicate-request', open: true },
        ]);
        const before = await scratch.collection('productionRun').find().toArray();
        const report = await auditProductionReadiness(scratch);
        assert.equal(report.databaseChecksPassed, false);
        assert.ok(report.indexes.every(index => !index.present));
        assert.equal(report.duplicates.find(item => item.check === 'openRunsPerLine').groups, 1);
        assert.equal(report.duplicates.find(item => item.check === 'runStartRequests').groups, 1);
        assert.deepEqual(await scratch.collection('productionRun').find().toArray(), before);
        assert.equal((await scratch.collection('productionRun').listIndexes().toArray()).length, 1);
        assert.equal((await scratch.listCollections().toArray()).length, 1);
    });

    await t.test('invalid quantities and unauthorized operations are rejected without output or stock changes', async () => {
        const original = user;
        user = { _id: original._id, permission: {} };
        assert.equal((await call('productionHealth:get', {})).message, 'productionRun.errors.permission');
        assert.equal((await call('pallet:register', registration())).message, 'productionPallet.errors.permission');
        assert.equal((await call('pallet:putaway', { palletId: full._id })).message, 'productionPallet.errors.permission');
        assert.equal((await call('productionPallets:get', { lineId: String(lines[0]._id) })).status, 'error');
        user = original;
        for (const boxes of [0, -1, 1.5, '3', Infinity]) assert.equal((await call('pallet:register', { ...registration(), boxes })).message, 'productionPallet.errors.quantity');
    });
    await t.test('phone access uses employee PINs without a station and shares desktop registration safely', async () => {
        const express = require('express');
        const jwt = require('jsonwebtoken');
        const app = express(); app.use(express.json());
        const mobile = load('routes/productionMobile.js', {
            express, jsonwebtoken: jwt, 'node:crypto': require('node:crypto'),
            '../models': db, '../config/database': database, '../utils/dayjs': dayjs,
            '../socket/session': { JWT_SECRET: 'isolated-mobile-test-secret' },
            '../utils/productionMetrics': require('../utils/productionMetrics'),
            '../utils/productionPalletActions': require('../utils/productionPalletActions'),
        });
        app.use('/mobile', mobile);
        const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
        const base = `http://127.0.0.1:${server.address().port}/mobile`;
        const request = async (route, body, token) => {
            const response = await fetch(base + route, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
            return { status: response.status, data: await response.json() };
        };
        try {
            await db.employee.updateOne({ _id: employee._id }, { $set: { pin: '123456' } });
            const outsider = await db.employee.create({ firstName: 'Other employee', pin: '654321', hiringStatus: 'Active', employment: { status: 'Active' } });
            const line = await db.line.create({ name: 'Mobile line', description: 'Isolated mobile fixture', steps: [{ name: 'Packing', mainWorkers: [employee._id] }] });
            const profile = await db.parameter.create({ lineId: line._id, name: 'Mobile profile', settings: [] });
            const run = (await success('productionRun:start', { lineId: String(line._id), productId: String(product._id), profileId: String(profile._id), schedule,
                crew: [{ stepId: String(line.steps[0]._id), slotIndex: 0, employeeId: String(employee._id), enabled: true }], requestId: randomUUID() })).run;
            const login = pin => request('/login', { lineId: String(line._id), pin });
            assert.equal((await request('/context')).status, 401);
            assert.equal((await login('000000')).status, 403);
            assert.equal((await login(outsider.pin)).status, 403);
            const signedIn = await login('123456');
            assert.equal(signedIn.status, 200);
            assert.equal(signedIn.data.employeeId, String(employee._id));
            assert.equal(signedIn.data.pin, undefined);
            const token = signedIn.data.token;
            const userToken = jwt.sign({ id: String(user._id) }, 'isolated-mobile-test-secret');
            assert.equal((await request('/context', null, userToken)).status, 401);
            const context = await request('/context', null, token);
            assert.equal(context.status, 200);
            assert.equal(context.data.run.productName, product.styleName);
            assert.equal(context.data.run.crew, undefined);
            const payload = { lineId: String(line._id), runId: String(run._id), lotNumber: run.lotNumber, boxes: 2, requestId: randomUUID() };
            assert.equal((await request('/register', { ...payload, lineId: String(lines[0]._id) }, token)).status, 409);
            const registered = await request('/register', payload, token);
            assert.equal(registered.status, 200, registered.data.message);
            const pallet = registered.data.pallet;
            assert.equal(pallet.registeredByEmployee, String(employee._id));
            assert.equal(pallet.registeredBy, undefined);
            assert.equal(pallet.trace[0].employeeId, String(employee._id));
            assert.equal((await request('/register', payload, token)).data.pallet._id, pallet._id);
            assert.equal(await db.pallet.countDocuments({ productionRunId: run._id }), 1);
            const desktop = await success('productionPallets:get', { lineId: String(line._id) });
            assert.equal(desktop.totals.pallets, 1);
            assert.equal(desktop.totals.pillows, pallet.quantity);
            assert.equal((await request('/prepare-print', { palletId: full._id, requestId: randomUUID(), printer: 'RW403B' }, token)).status, 409);
            const print = { palletId: pallet._id, requestId: randomUUID(), printer: 'RW403B' };
            assert.equal((await request('/prepare-print', print, token)).status, 200);
            assert.equal((await request('/print-result', { ...print, result: 'Submitted' }, token)).status, 200);
            assert.equal((await request('/print-result', { ...print, result: 'Submitted' }, token)).status, 200);
            assert.equal(await db.pallet.countDocuments({ productionRunId: run._id }), 1);
            await db.productionRun.updateOne({ _id: run._id }, { $set: { lotNumber: 'L000ZZZZZ' } });
            assert.equal((await request('/register', { ...payload, requestId: randomUUID() }, token)).data.message, 'productionPallet.errors.lotChanged');
            await db.productionRun.updateOne({ _id: run._id }, { $set: { 'crew.0.enabled': false } });
            const recoveryContext = await request('/context', null, token);
            assert.equal(recoveryContext.status, 200);
            assert.equal(recoveryContext.data.run, null);
            assert.equal(recoveryContext.data.recoveryOnly, true);
            assert.equal((await request('/register', { ...payload, requestId: randomUUID(), lotNumber: 'L000ZZZZZ' }, token)).data.message, 'productionPallet.errors.permission');
            await db.productionRun.updateOne({ _id: run._id }, { $set: { open: false, status: 'Ended', endedAt: new Date() } });
            assert.equal((await request('/register', payload, token)).data.pallet._id, pallet._id);
            assert.equal((await request('/register', { ...payload, requestId: randomUUID() }, token)).data.message, 'productionPallet.errors.run');
            const recoveryLogin = await login('123456');
            assert.equal(recoveryLogin.status, 200, 'An employee can sign in again to recover an owned pallet after production ends');
            const recoveredToken = recoveryLogin.data.token;
            const recoveredPrint = { palletId: pallet._id, requestId: randomUUID(), printer: 'RW403B' };
            assert.equal((await request('/prepare-print', recoveredPrint, recoveredToken)).status, 200);
            assert.equal((await request('/print-result', { ...recoveredPrint, result: 'Submitted' }, recoveredToken)).status, 200);
            assert.equal((await request('/prepare-print', { ...recoveredPrint, palletId: full._id, requestId: randomUUID() }, recoveredToken)).status, 409);
            assert.equal((await request('/register', { ...payload, requestId: randomUUID() }, recoveredToken)).data.message, 'productionPallet.errors.run');
            assert.equal((await login(outsider.pin)).status, 403, 'Recovery does not open the line to employees without owned pallets');
            await db.employee.updateOne({ _id: employee._id }, { $set: { pin: '234567' } });
            assert.equal((await request('/context', null, token)).status, 401);
            await db.employee.updateOne({ _id: employee._id }, { $set: { pin: '123456', 'employment.status': 'Terminated' } });
            assert.equal((await request('/context', null, token)).status, 401);
        } finally {
            await db.employee.updateOne({ _id: employee._id }, { $set: { 'employment.status': 'Active' } });
            await new Promise(resolve => server.close(resolve));
        }
    });

});
