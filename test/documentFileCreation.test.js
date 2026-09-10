const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');
const mongoose = require('mongoose');
const { normalizePathPart } = require('../utils/documentStorage');
const source = fs.readFileSync(require.resolve('../socket/event/document'), 'utf8');
const registration = source.match(/socket\.on\("documentFile:create",[\s\S]*?\n    \}\);/)[0];

const fixture = () => {
    const calls = [], controls = {};
    const dropbox = {};
    let handler, record;
    vm.runInNewContext(registration, {
        socket: { on: (event, callback) => { handler = callback; } },
        safeCallback: callback => callback,
        requireUser: async () => ({ _id: 'b'.repeat(24) }),
        requireAccess: () => controls.allowed !== false,
        getConfiguredDropbox: async () => controls.unconfigured ? null : dropbox,
        mongoose, Buffer, ArrayBuffer, normalizePathPart,
        normalizeDocumentCategory: value => value,
        nextDocumentNumber: async category => { calls.push({ category }); return 'QMS-REC-001'; },
        uploadDocumentFile: async input => {
            calls.push({ upload: input });
            if (controls.uploadError) throw new Error('Dropbox unavailable');
            return { storagePath: `/DocumentCenter/${input.documentId}/draft/original/${input.fileName}`, url: 'https://www.dropbox.com/scanned.pdf' };
        },
        db: { document: {
            create: async input => { record = input; calls.push({ create: input }); return input; },
            findById: () => ({ populate() { return this; }, lean: async () => record }),
        } },
        DOCUMENT_POPULATE: [], serializeDocument: value => value,
        io: { emit: (event, payload) => calls.push({ event, payload }) },
    });
    return { calls, controls, dropbox, run: async (overrides = {}) => {
        let response;
        await handler({ fileName: '扫描 Inspection September.pdf', mimeType: 'application/pdf',
            content: Buffer.from('%PDF-1.7\nscanned fixture'), title: 'Signed inspection', folder: 'Quality',
            documentCategory: 'Record', autoDocumentNumber: true, summary: 'Signed September record',
            ...overrides }, result => { response = result; });
        return response;
    } };
};

test('PDF creation stores the original in configured Dropbox and searchable metadata in MES', async () => {
    const state = fixture();
    const response = await state.run();
    assert.equal(response.status, 'success');
    const upload = state.calls.find(call => call.upload).upload;
    assert.equal(upload.dropbox, state.dropbox);
    assert.equal(upload.category, 'original');
    const document = response.payload;
    assert.equal(document.type, 'uploaded-file');
    assert.equal(document.documentNumber, 'QMS-REC-001');
    assert.equal(document.title, 'Signed inspection');
    assert.equal(document.folder, 'Quality');
    assert.equal(document.summary, 'Signed September record');
    assert.equal(document.attachments[0].name, '扫描 Inspection September.pdf');
    assert.equal(document.attachments[0].size, upload.contents.length);
    assert.equal(document.attachments[0].mimeType, 'application/pdf');
    assert.ok(document.attachments[0].uploadedAt);
    assert.ok(document.attachments[0].storagePath.includes('/original/'));
    assert.equal(document.content, undefined);
    assert.ok(state.calls.some(call => call.event === 'document:created'));
});

test('manual numbers are preserved and sliced binary views upload only their PDF bytes', async () => {
    const state = fixture();
    const bytes = Buffer.from('prefix%PDF-1.7\nscanned-suffix');
    const content = new Uint8Array(bytes.buffer, bytes.byteOffset + 6, 16);
    const response = await state.run({ content, autoDocumentNumber: false, documentNumber: 'SCAN-42' });
    assert.equal(response.status, 'success');
    assert.equal(response.payload.documentNumber, 'SCAN-42');
    assert.deepEqual(state.calls.find(call => call.upload).upload.contents, Buffer.from(content));
    assert.ok(!state.calls.some(call => call.category));
});

test('invalid, empty, and oversized PDFs cannot upload or create a MES record', async () => {
    for (const content of [Buffer.from('not a PDF'), Buffer.alloc(0), Buffer.alloc(8 * 1024 * 1024 + 1)]) {
        const state = fixture();
        assert.equal((await state.run({ content })).status, 'error');
        assert.equal(state.calls.length, 0);
    }
});

test('storage failure and missing configuration cannot create a document or broadcast success', async () => {
    for (const control of ['unconfigured', 'uploadError']) {
        const state = fixture();
        state.controls[control] = true;
        assert.equal((await state.run()).status, 'error');
        assert.ok(!state.calls.some(call => call.create || call.event));
    }
});

test('PDF creation retains the existing file-create permission gate', async () => {
    const state = fixture();
    state.controls.allowed = false;
    await state.run();
    assert.equal(state.calls.length, 0);
});
