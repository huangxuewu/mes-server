const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../utils/documentLifecycle.js'), 'utf8');
const fixture = (records, mutateAfterRead) => {
    const calls = [], emitted = [];
    const copy = value => structuredClone(value);
    const matches = (record, filter) => Object.entries(filter).every(([key, value]) => {
        if (value === null) return record[key] == null;
        if (value?.$in) return value.$in.includes(record[key]);
        return String(record[key]) === String(value);
    });
    const db = { document: {
        find: filter => {
            const selected = records.filter(record => matches(record, filter)).map(copy);
            const finish = () => {
                mutateAfterRead?.(records);
                return selected;
            };
            return {
                select(fields) { calls.push({ select: fields }); return this; },
                lean: async () => finish(),
                then(resolve) {
                    finish();
                    resolve(selected.map(snapshot => ({ ...snapshot, async save() {
                        calls.push({ unguarded: true });
                        records.find(record => record._id === snapshot._id).status = this.status;
                    } })));
                },
            };
        },
        updateOne: async (filter, update) => {
            calls.push({ filter, update });
            const record = records.find(record => matches(record, filter));
            if (!record) return { modifiedCount: 0 };
            Object.assign(record, update.$set);
            return { modifiedCount: 1 };
        },
        findById: id => ({
            populate() { return this; },
            lean: async () => copy(records.find(record => record._id === id)),
        }),
    } };
    const module = { exports: {} };
    vm.runInNewContext(source, { require: name => { if (name === './documentAccess') return { protectedDocumentEmitter: io => io }; assert.equal(name, '../models'); return db; }, module, console, Date });
    return { calls, emitted, run: () => module.exports.refreshDocumentLifecycle({ emit: (name, payload) => emitted.push({ name, payload }) }) };
};
const past = new Date('2000-01-01T00:00:00Z');
const future = new Date('2100-01-01T00:00:00Z');
const document = (values = {}) => ({ _id: 'document-a', isTemplate: false, status: 'Published', currentRevision: 2, expiryBehavior: 'Deactivate', expiresAt: past, ...values });

test('a lifecycle scan cannot overwrite a draft or archive created after its read', async () => {
    for (const status of ['Draft', 'In Review', 'Archived']) {
        const records = [document()];
        const state = fixture(records, records => records[0].status = status);
        await state.run();
        assert.equal(records[0].status, status);
        assert.equal(state.emitted.length, 0);
    }
});

test('lifecycle updates preserve newer publication, expiry and review settings', async () => {
    for (const change of [{ currentRevision: 3 }, { expiresAt: future }, { expiryBehavior: 'Warn' }, { reviewDueAt: future }, { isTemplate: true }]) {
        const records = [document()];
        const state = fixture(records, records => Object.assign(records[0], change));
        await state.run();
        assert.equal(records[0].status, 'Published');
        assert.equal(state.emitted.length, 0);
    }
});

test('unchanged snapshots still expire, become overdue and recover their published status', async () => {
    const cases = [
        [document(), 'Expired'],
        [document({ expiresAt: future, reviewDueAt: past }), 'Review Overdue'],
        [document({ expiryBehavior: 'Warn', reviewDueAt: past }), 'Review Overdue'],
        [document({ status: 'Expired', expiresAt: future }), 'Published'],
        [document({ status: 'Review Overdue', expiresAt: future, reviewDueAt: future }), 'Published'],
    ];
    for (const [record, expected] of cases) {
        const state = fixture([record]);
        await state.run();
        assert.equal(record.status, expected);
        assert.equal(state.emitted.length, 1);
        assert.equal(state.emitted[0].name, 'document:updated');
        assert.equal(state.emitted[0].payload.status, expected);
    }
});

test('status scans exclude content and do not write or broadcast unchanged documents', async () => {
    const records = [document({ expiresAt: future }), document({ _id: 'draft', status: 'Draft' })];
    const state = fixture(records);
    await state.run();
    const selection = state.calls.find(call => call.select)?.select.split(/\s+/).sort();
    assert.deepEqual(selection, ['_id', 'currentRevision', 'expiresAt', 'expiryBehavior', 'reviewDueAt', 'status'].sort());
    assert.equal(state.calls.filter(call => call.filter || call.unguarded).length, 0);
    assert.equal(state.emitted.length, 0);
});

test('form entry eligibility rejects elapsed deactivation before the next lifecycle scan', async () => {
    const formSource = fs.readFileSync(path.join(__dirname, '../socket/event/form.js'), 'utf8');
    const load = formSource.match(/const getPublishedForm = async [\s\S]*?\n    };/)[0];
    for (const status of ['Published', 'Review Overdue']) {
        let revisionReads = 0;
        const record = document({ status });
        const getPublishedForm = vm.runInNewContext(`${load}\ngetPublishedForm;`, {
            mongoose: { isValidObjectId: () => true }, Date,
            db: {
                document: { findOne: () => ({ lean: async () => record }) },
                documentRevision: { findOne: () => ({ lean: async () => { revisionReads++; return { formSchema: {} }; } }) },
            },
        });
        await assert.rejects(getPublishedForm(record._id), /expired/i);
        assert.equal(revisionReads, 0);
        record.expiresAt = future;
        assert.ok((await getPublishedForm(record._id)).revision.formSchema);
        record.expiresAt = past;
        record.expiryBehavior = 'Warn';
        assert.ok((await getPublishedForm(record._id)).revision.formSchema);
        record.expiresAt = null;
        record.expiryBehavior = 'Deactivate';
        assert.ok((await getPublishedForm(record._id)).revision.formSchema);
    }
});
