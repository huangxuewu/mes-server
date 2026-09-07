const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../socket/event/form.js'), 'utf8');

const fixture = (status = 'Draft') => {
    const calls = [];
    const document = { _id: 'form-a', title: 'Renamed working form', documentNumber: 'FORM-200', status,
        currentRevision: 3, formSchema: { fields: [{ id: 'new-field', type: 'text', label: 'New question' }] }, relatedDocuments: [] };
    const revision = { _id: 'revision-2', document: document._id, title: 'Original approved inspection', documentNumber: 'FORM-100', revision: 2,
        formSchema: { fields: [{ id: 'check', type: 'text', label: 'Original question', required: true }] },
        relatedDocuments: [{ role: 'SOP', documentNumber: 'SOP-100', revision: 4 }] };
    const submission = { _id: 'entry-a', document: document._id, formRevision: 2, entryNumber: 'FORM-100-2026-00001',
        status: 'Draft', recordedAt: new Date('2026-09-06T12:00:00Z'), answers: [],
        save: async () => { calls.push(['save', submission.status]); } };
    let missingRevision = false;
    const populated = value => ({ populate: () => ({ lean: async () => value }) });
    const db = {
        user: { findById: () => ({ lean: async () => ({ _id: 'operator', role: 'System' }) }) },
        document: { findOne: () => ({ lean: async () => document }), findById: () => ({ lean: async () => document }) },
        documentRevision: { findOne: query => ({ lean: async () => {
            calls.push(['revision-query', query]);
            return missingRevision ? null : revision;
        } }) },
        counter: { findByIdAndUpdate: async () => { calls.push(['counter']); return { sequence: 2 }; } },
        formSubmission: {
            findById: () => Object.assign(submission, populated(submission)),
            create: async value => { Object.assign(submission, value); calls.push(['create', value]); return submission; },
        },
    };
    const dependencies = {
        mongoose: { isValidObjectId: () => true },
        '../../models': db,
        '../session': { getSessionUserId: () => 'operator', hasPermission: () => true, getActiveSessionUser: async () => ({ _id: 'operator', role: 'System' }) },
        '../../utils/documentAccess': { protectDocumentSocket: socket => socket, protectedDocumentEmitter: io => io, safeDocument: async value => value },
        '../../utils/formPdf': { createFormPdf: async input => {
            calls.push(['render', input]);
            return Buffer.from(JSON.stringify(input));
        } },
        '../../utils/documentStorage': {
            getDropbox: () => ({}), normalizePathPart: value => value,
            uploadDocumentFile: async input => {
                calls.push(['upload', input]);
                return { url: 'https://example.test/form.pdf', storagePath: '/form-a/revision-2/form.pdf' };
            },
        },
    };
    const context = { module: { exports: {} }, require: name => {
        assert.ok(name in dependencies, `Unexpected dependency: ${name}`);
        return dependencies[name];
    } };
    vm.runInNewContext(source, context);
    const handlers = new Map();
    context.module.exports({ on: (name, handler) => handlers.set(name, handler) }, { emit: (...args) => calls.push(['emit', ...args]) });
    return { document, revision, submission, calls,
        setMissingRevision: () => { missingRevision = true; },
        run: async (event, input) => {
            let response;
            await handlers.get(event)(input, value => response = value);
            return response;
        },
    };
};

test('historical blank form uses the saved title, number, fields and SOP revisions after a rename', async () => {
    const state = fixture();
    state.document.documentNumber = '';
    const response = await state.run('form:generate', { documentId: state.document._id, revision: 2 });
    assert.equal(response.status, 'success');
    assert.equal(response.payload.fileName, 'FORM-100-rev-2-blank.pdf');
    const rendered = state.calls.find(call => call[0] === 'render')[1];
    assert.equal(rendered.document.title, state.revision.title);
    assert.equal(rendered.document.documentNumber, state.revision.documentNumber);
    assert.equal(rendered.formSchema, state.revision.formSchema);
    assert.equal(rendered.relatedDocuments, state.revision.relatedDocuments);
    const upload = state.calls.find(call => call[0] === 'upload')[1];
    assert.equal(upload.documentId, state.document._id);
    assert.equal(upload.revision, 2);
    assert.equal(upload.documentNumber, 'FORM-100');
});

test('default published blank form selects its published snapshot, while draft export uses working metadata', async () => {
    for (const status of ['Published', 'Draft', 'In Review']) {
        const state = fixture(status);
        state.document.currentRevision = 2;
        const response = await state.run('form:generate', { documentId: state.document._id });
        assert.equal(response.status, 'success');
        const rendered = state.calls.find(call => call[0] === 'render')[1];
        assert.equal(rendered.document, status === 'Published' ? state.revision : state.document);
        assert.equal(response.payload.fileName, status === 'Published' ? 'FORM-100-rev-2-blank.pdf' : 'FORM-200-draft-blank.pdf');
    }
});

test('submitting an older draft keeps the original form identity, schema, SOP references and entry number', async () => {
    const state = fixture();
    const response = await state.run('formSubmission:update', { _id: state.submission._id, status: 'Submitted',
        answers: [{ fieldId: 'check', value: 'Guard checked' }], recordedBy: 'Operator A' });
    assert.equal(response.status, 'success');
    const query = state.calls.find(call => call[0] === 'revision-query')[1];
    assert.equal(query.revision, 2);
    const rendered = state.calls.find(call => call[0] === 'render')[1];
    assert.equal(rendered.document, state.revision);
    assert.equal(rendered.formSchema, state.revision.formSchema);
    assert.equal(rendered.relatedDocuments, state.revision.relatedDocuments);
    assert.equal(rendered.submission.entryNumber, 'FORM-100-2026-00001');
    assert.equal(rendered.submission.answers[0].value, 'Guard checked');
    const upload = state.calls.find(call => call[0] === 'upload')[1];
    assert.equal(upload.documentId, state.document._id);
    assert.equal(upload.documentNumber, 'FORM-100');
    assert.equal(upload.revision, 2);
    assert.equal(response.payload.status, 'Submitted');
    assert.equal(state.document.status, 'Draft');
});

test('new completed entries render the selected published revision', async () => {
    const state = fixture('Published');
    state.document.currentRevision = 2;
    const response = await state.run('formSubmission:create', { documentId: state.document._id, status: 'Submitted',
        answers: [{ fieldId: 'check', value: 'Confirmed' }] });
    assert.equal(response.status, 'success');
    assert.equal(state.calls.find(call => call[0] === 'render')[1].document, state.revision);
    assert.equal(response.payload.formRevision, 2);
});

test('expired deactivated forms reject new drafts and submissions before allocating, rendering or writing', async () => {
    for (const status of ['Draft', 'Submitted']) {
        const state = fixture('Published');
        state.document.expiryBehavior = 'Deactivate';
        state.document.expiresAt = new Date('2000-01-01T00:00:00Z');
        const response = await state.run('formSubmission:create', {
            documentId: state.document._id, status, answers: [{ fieldId: 'check', value: 'Confirmed' }],
        });
        assert.equal(response.status, 'error');
        assert.match(response.message, /expired/);
        assert.equal(state.calls.length, 0);
    }
});

test('missing revisions or snapshot numbers fail without rendering or uploading a different form', async () => {
    for (const scenario of ['missing-revision', 'missing-number', 'missing-entry-revision']) {
        const state = fixture();
        if (scenario === 'missing-number') state.revision.documentNumber = '';
        else state.setMissingRevision();
        const response = scenario === 'missing-entry-revision'
            ? await state.run('formSubmission:update', { _id: state.submission._id, status: 'Submitted' })
            : await state.run('form:generate', { documentId: state.document._id, revision: 2 });
        assert.equal(response.status, 'error');
        assert.equal(state.calls.some(call => ['render', 'upload', 'save', 'emit'].includes(call[0])), false);
    }
});
