const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../socket/event/document.js'), 'utf8');
const registration = source.match(/socket\.on\("document:exportDocx",[\s\S]*?\n    \}\);/)[0];

const fixture = (status = 'Draft') => {
    const current = { _id: 'document-a', title: 'Renamed working procedure', documentNumber: 'QMS-PRO-200', status, currentRevision: 2,
        contentJson: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Current draft text' }] }] } };
    const revision = { _id: 'revision-a', document: current._id, title: 'Original approved procedure', documentNumber: 'QMS-PRO-100', revision: 2,
        contentJson: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Approved text' }] }] },
        artifacts: [], save: async () => { calls.push('save-revision'); } };
    const calls = [];
    let handler, response, missingRevision = false;
    vm.runInNewContext(registration, {
        socket: { on: (event, callback) => { handler = callback; } },
        safeCallback: callback => callback,
        safeDocument: async value => value, rawSocket: {},
        requireUser: async () => ({ _id: 'publisher' }), requireAccess: () => true,
        mongoose: { isValidObjectId: () => true },
        db: {
            document: { findById: () => ({ lean: async () => current }) },
            documentRevision: {
                findOne: query => ({ lean: async () => { calls.push(['revision-query', query]); return missingRevision ? null : revision; } }),
                findById: async () => revision,
            },
        },
        normalizePathPart: value => String(value).replaceAll(' ', '-'),
        createDocumentDocx: async value => { calls.push(['render', value]); return Buffer.from(JSON.stringify(value)); },
        uploadDocumentFile: async value => { calls.push(['upload', value]); return { url: 'https://example.test/revision.docx', storagePath: '/published/rev-2.docx' }; },
    });
    return { current, revision, calls,
        setMissingRevision: () => { missingRevision = true; },
        run: async input => { await handler({ _id: current._id, ...input }, result => { response = result; }); return response; },
    };
};

test('explicit historical DOCX export uses the revision title, number and content after the working document is renamed', async () => {
    const state = fixture();
    const response = await state.run({ revision: 2 });
    assert.equal(response.status, 'success');
    assert.equal(response.payload.fileName, 'QMS-PRO-100-rev-2.docx');
    const rendered = JSON.parse(Buffer.from(response.payload.base64, 'base64').toString());
    assert.equal(rendered.title, state.revision.title);
    assert.equal(rendered.documentNumber, state.revision.documentNumber);
    assert.deepEqual(rendered.contentJson, state.revision.contentJson);
    const upload = state.calls.find(call => call[0] === 'upload')[1];
    assert.equal(upload.documentId, state.current._id);
    assert.equal(upload.revision, 2);
    assert.equal(upload.fileName, 'QMS-PRO-100-rev-2.docx');
    assert.equal(state.current.status, 'Draft');
    assert.equal(state.revision.artifacts[0].format, 'docx');
});

test('default export of a published record selects its published revision metadata', async () => {
    const state = fixture('Published');
    const response = await state.run({});
    assert.equal(response.status, 'success');
    assert.equal(state.calls.find(call => call[0] === 'revision-query')[1].revision, 2);
    assert.equal(JSON.parse(Buffer.from(response.payload.base64, 'base64').toString()).title, state.revision.title);
});

test('draft DOCX export still uses current working metadata and does not store a published artifact', async () => {
    const state = fixture();
    const response = await state.run({});
    assert.equal(response.payload.fileName, 'QMS-PRO-200-draft.docx');
    assert.equal(JSON.parse(Buffer.from(response.payload.base64, 'base64').toString()).title, state.current.title);
    assert.equal(state.calls.length, 1);
    assert.equal(state.calls[0][0], 'render');
});

test('imported-file DOCX exports are identified as notes for both draft and historical snapshots', async () => {
    const state = fixture(); state.current.type = 'uploaded-file';
    const draft = await state.run({});
    assert.equal(draft.payload.fileName, 'QMS-PRO-200-notes-draft.docx');
    const historical = await state.run({ revision: 2 });
    assert.equal(historical.payload.fileName, 'QMS-PRO-100-notes-rev-2.docx');
    assert.equal(state.calls.find(call => call[0] === 'upload')[1].fileName, historical.payload.fileName);
    assert.equal(JSON.parse(Buffer.from(historical.payload.base64, 'base64').toString()).title, state.revision.title);
});

test('a missing historical revision fails without generating or uploading the current draft', async () => {
    const state = fixture();
    state.setMissingRevision();
    const response = await state.run({ revision: 2 });
    assert.equal(response.status, 'error');
    assert.equal(response.message, 'Revision not found');
    assert.equal(state.calls.length, 1);
    assert.equal(state.calls[0][0], 'revision-query');
});

test('historical exports preserve page fields and company identity from the selected revision', async()=>{
    const state=fixture();
    state.current.page={companyName:'Renamed company',header:{enabled:true,left:'Current'}};
    state.revision.page={companyName:'Original company',header:{enabled:true,left:'{companyName}'},footer:{enabled:true,right:'Page {page} of {pages}'}};
    state.revision.effectiveAt='2026-08-01T00:00:00Z';
    const response=await state.run({revision:2});
    assert.equal(response.status,'success');
    const rendered=JSON.parse(Buffer.from(response.payload.base64,'base64').toString());
    assert.deepEqual(rendered.page,state.revision.page);
    assert.equal(rendered.effectiveAt,state.revision.effectiveAt);
});
