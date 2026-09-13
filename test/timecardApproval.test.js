const assert = require('node:assert/strict');
const test = require('node:test');
const { timecardApprovalFixture } = require('./support/timecardApprovalFixture');
const uri = process.env.DATA_SYNC_TEST_URI;
const integration = { skip: !uri };
const fixture = async t => {
    const f = await timecardApprovalFixture(uri);
    t.after(f.close);
    return f;
};

test('punch approval saves totals and hash once without repeated schedule or request reads', integration, async t => {
    const f = await fixture(t);
    const result = await f.call();
    assert.equal(result.status, 'success');
    assert.equal(result.payload.status, 'Approved');
    assert.equal(result.payload.submittedBy.displayName, 'Requester');
    assert.equal(result.payload.verdictBy.displayName, 'Approver');
    assert.equal(f.commands.filter(command => command.find === 'employee').length, 1);
    assert.equal(f.commands.filter(command => command.find === 'changeRequest').length, 1);
    assert.equal(f.commands.filter(command => command.update === 'timecard' || command.findAndModify === 'timecard').length, 1);
    const employeeRead = f.commands.find(command => command.find === 'employee');
    assert.ok(employeeRead.projection && !employeeRead.projection.portrait);
    const saved = await f.db.timecard.findById(f.timecard._id);
    assert.equal(saved.totals.workMinutes, 510);
    assert.equal(saved.totals.overtimeMinutes, 0);
    assert.equal(saved.punches[1].method, 'Manual');
    assert.equal(saved.auditLog.length, 1);
    assert.equal(String(saved.auditLog[0].createdBy), String(f.submitter._id));
    assert.equal(saved.verifyIntegrity().isValid, true);
});

test('approval keeps permission, self-approval and conflict checks before any writes', integration, async t => {
    const f = await fixture(t);
    await f.db.user.updateOne({ _id: f.actor._id }, { $set: { role: 'User' } });
    assert.equal((await f.call()).status, 'error');
    assert.equal((await f.db.changeRequest.findById(f.request._id)).status, 'Pending');
    await f.db.user.updateOne({ _id: f.actor._id }, { $set: { role: 'Manager' } });
    await f.db.changeRequest.updateOne({ _id: f.request._id }, { $set: { submittedBy: f.actor._id } });
    const ownRequest = await f.call();
    assert.equal(ownRequest.status, 'error');
    assert.match(ownRequest.message, /own change request/);
    assert.equal((await f.db.changeRequest.findById(f.request._id)).status, 'Pending');
    await f.db.changeRequest.updateOne({ _id: f.request._id }, { $set: { submittedBy: f.submitter._id } });
    await f.db.user.updateOne({ _id: f.actor._id }, { $set: { role: 'Admin' } });
    await f.db.timecard.collection.updateOne({ _id: f.timecard._id }, { $set: { 'punches.1.time': new Date('2026-09-11T21:00:00Z') } });
    const conflict = await f.call();
    assert.equal(conflict.status, 'error');
    assert.equal(conflict.payload.conflict, true);
    assert.equal((await f.db.changeRequest.findById(f.request._id)).status, 'Pending');
    assert.equal((await f.call('changeRequest:approve', { force: true })).status, 'success');
    assert.equal((await f.call()).status, 'error');
});

test('partial approval keeps rejected punches and applies only accepted edits', integration, async t => {
    const f = await fixture(t);
    const afterValue = f.request.afterValue.map((punch, index) => index ? punch
        : { ...punch, time: new Date('2026-09-11T12:15:00Z') });
    await f.db.changeRequest.updateOne({ _id: f.request._id }, { $set: { afterValue } });
    const result = await f.call('changeRequest:approve', { rejectedChanges: [{ beforeIndex: 0, afterIndex: 0 }] });
    assert.equal(result.status, 'success');
    assert.equal(result.payload.rejectedChanges.length, 1);
    const saved = await f.db.timecard.findById(f.timecard._id);
    assert.equal(saved.punches[0].time.toISOString(), '2026-09-11T12:00:00.000Z');
    assert.equal(saved.punches[0].method, 'Station');
    assert.equal(saved.punches[1].time.toISOString(), '2026-09-11T20:30:00.000Z');
    assert.equal(saved.punches[1].method, 'Manual');
    assert.equal(saved.totals.workMinutes, 510);
    assert.equal(saved.auditLog[0].changes.length, 1);
    assert.equal(saved.verifyIntegrity().isValid, true);
});

test('a failed timecard save leaves the request pending and punches unchanged', integration, async t => {
    const f = await fixture(t);
    const updateOne = f.db.timecard.collection.updateOne;
    f.db.timecard.collection.updateOne = async () => { throw new Error('Injected timecard write failure'); };
    t.after(() => { f.db.timecard.collection.updateOne = updateOne; });
    const result = await f.call();
    assert.equal(result.status, 'error');
    assert.match(result.message, /Injected timecard write failure/);
    assert.equal((await f.db.changeRequest.findById(f.request._id)).status, 'Pending');
    const saved = await f.db.timecard.findById(f.timecard._id);
    assert.equal(saved.punches[1].time.toISOString(), '2026-09-11T20:00:00.000Z');
    assert.equal(saved.auditLog.length, 0);
    assert.equal(saved.verifyIntegrity().isValid, true);
});

test('timecard update hook calculates schedule once and honors meal-break policy', integration, async t => {
    const f = await fixture(t);
    await f.db.timecard.findByIdAndUpdate(f.timecard._id, { $set: { 'overtime.honorShortMealBreak': true } }, { new: true });
    assert.equal(f.commands.filter(command => command.find === 'employee').length, 1);
    const saved = await f.db.timecard.findById(f.timecard._id);
    assert.equal(saved.overtime.honorShortMealBreak, true);
    assert.equal(saved.verifyIntegrity().isValid, true);
});
