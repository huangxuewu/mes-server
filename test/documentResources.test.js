const assert = require("node:assert/strict");
const test = require("node:test");
const Y = require("yjs");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { cleanupDocumentResources, resourceKey } = require("../utils/documentResources");

const asset = {
    _id: "resource1", purpose: "resource", mimeType: "image/png", name: "photo.png",
    url: "https://www.dropbox.com/scl/fi/photo/photo.png?raw=1",
    storagePath: "/DH MES/document/doc1/assets/photo.png",
};
const image = { type: "image", attrs: { src: asset.url } };
const fixture = ({ owner = {}, others = [], revisions = [], failure, missing = false, liveDocuments = new Map(), changed = false } = {}) => {
    const removed = [];
    const deleted = [];
    const query = (value) => ({ select() { return this; }, lean() { return this; },
        then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); },
        cursor: () => ({ async *[Symbol.asyncIterator]() { yield* value; }, async close() {} }),
    });
    const db = {
        document: {
            findById: () => query({ _id: "doc1", attachments: [asset], ...owner }),
            find: () => query([{ _id: "doc1", attachments: [asset], ...owner }, ...others]),
            exists: async () => changed,
            updateOne: async (_, update) => removed.push(...update.$pull.attachments._id.$in),
        },
        documentRevision: { find: () => query(revisions), exists: async () => false },
    };
    const dropbox = {
        filesGetMetadata: async () => {
            if (missing) throw { error: { error_summary: "path/not_found/" } };
            return { result: { ".tag": "file" } };
        },
        filesDeleteV2: async ({ path }) => {
            if (failure) throw failure;
            deleted.push(path);
        },
    };
    return { removed, deleted, run: () => cleanupDocumentResources({ documentId: "doc1", resourceIds: ["resource1", "resource2"], db, dropbox, liveDocuments }) };
};

test("unused resources are deleted from Dropbox before their metadata is removed", async () => {
    for (const root of ["/DocumentCenter", "/DH MES/document", "/MES/DocumentCenter"]) {
        const storagePath = `${root}/doc1/assets/photo.png`;
        const result = fixture({ owner: { attachments: [{ ...asset, storagePath }] } });
        await result.run();
        assert.deepEqual(result.deleted, [storagePath]);
        assert.deepEqual(result.removed, [asset._id]);
    }
});

test("multiple unused resources are cleaned up together", async () => {
    const second = { ...asset, _id: "resource2", url: "https://www.dropbox.com/s/second/photo.png", storagePath: "/DH MES/document/doc1/assets/second.png" };
    const result = fixture({ owner: { attachments: [asset, second] } });
    await result.run();
    assert.deepEqual(result.deleted, [asset.storagePath, second.storagePath]);
    assert.deepEqual(result.removed, [asset._id, second._id]);
});

test("imported originals are never removed as unused images, including legacy or misclassified metadata", async () => {
    for (const purpose of [undefined, "attachment", "resource"]) {
        const original = { ...asset, purpose, storagePath: "/DH MES/document/doc1/draft/original/photo.png" };
        const result = fixture({ owner: { type: "uploaded-file", attachments: [original] } });
        await result.run();
        assert.deepEqual(result.deleted, []);
        assert.deepEqual(result.removed, []);
    }
});

test("file import marks the original as an attachment before publishing its document", async () => {
    const source = fs.readFileSync(path.join(__dirname, "../socket/event/document.js"), "utf8");
    const handlerSource = source.match(/socket\.on\("documentFile:create",[\s\S]*?\n    \}\);/)[0];
    let handler, saved;
    const events = [];
    const storagePath = "/DH MES/document/doc1/draft/original/photo.png";
    vm.runInNewContext(handlerSource, {
        socket: { on: (_, callback) => { handler = callback; } },
        safeCallback: callback => callback, requireUser: async () => ({ _id: "operator" }), requireAccess: () => true,
        getConfiguredDropbox: async () => ({}), Buffer, ArrayBuffer,
        mongoose: { Types: { ObjectId: function () { return { toString: () => "doc1" }; } } },
        normalizeDocumentCategory: value => value, normalizePathPart: value => value, DOCUMENT_POPULATE: [], serializeDocument: value => value,
        uploadDocumentFile: async input => {
            assert.equal(input.category, "original");
            return { storagePath, url: asset.url };
        },
        db: { document: {
            create: async input => { saved = input; return saved; },
            findById: () => ({ populate: () => ({ lean: async () => saved }) }),
        } },
        io: { emit: (event, payload) => events.push({ event, payload }) },
    });
    let response;
    await handler({ fileName: "photo.png", mimeType: "image/png", content: Buffer.from("image fixture") }, value => { response = value; });
    assert.equal(response.status, "success");
    assert.equal(saved.type, "uploaded-file");
    assert.equal(saved.attachments[0].purpose, "attachment");
    assert.equal(saved.attachments[0].storagePath, storagePath);
    assert.equal(events[0].payload.attachments[0].purpose, "attachment");
});

test("content, links, thumbnails, templates, revisions and explicit attachments protect files", async () => {
    for (const input of [
        { owner: { contentJson: { content: [image] } } },
        { owner: { contentJson: { marks: [{ attrs: { href: asset.url.replace("raw=1", "dl=0") } }] } } },
        { owner: { thumbnail: { url: asset.url } } },
        { owner: { attachments: [{ ...asset, purpose: "attachment" }] } },
        { others: [{ _id: "template1", contentJson: image }] },
        { others: [{ _id: "doc2", attachments: [asset] }] },
        { revisions: [{ contentJson: image }] },
        { changed: true },
    ]) {
        const result = fixture(input);
        await result.run();
        assert.deepEqual(result.deleted, []);
        assert.deepEqual(result.removed, []);
    }
});

test("live and persisted collaboration references protect a resource", async () => {
    const shared = new Y.Doc();
    const node = new Y.XmlElement("image");
    node.setAttribute("src", asset.url);
    shared.getXmlFragment("default").insert(0, [node]);
    for (const input of [
        { liveDocuments: new Map([["doc1", shared]]) },
        { owner: { yjsState: Buffer.from(Y.encodeStateAsUpdate(shared)) } },
        { owner: { yjsState: new (require('mongoose').mongo.Binary)(Y.encodeStateAsUpdate(shared)) } },
    ]) {
        const result = fixture(input);
        await result.run();
        assert.deepEqual(result.deleted, []);
    }
    shared.destroy();
});

test('corrupt persisted collaboration state prevents resource deletion', async () => {
    const result = fixture({ owner: { yjsState: Buffer.from([1]) } });
    await assert.rejects(result.run());
    assert.deepEqual(result.deleted, []);
    assert.deepEqual(result.removed, []);
});

test("Dropbox errors retain metadata, and already missing files can finish cleanup", async () => {
    const failure = fixture({ failure: new Error("Dropbox unavailable") });
    await assert.rejects(failure.run(), /Dropbox unavailable/);
    assert.deepEqual(failure.removed, []);
    const missing = fixture({ missing: true });
    await missing.run();
    assert.deepEqual(missing.removed, [asset._id]);
});

test("cleanup cannot delete another document's file or a folder path", async () => {
    for (const storagePath of ["/DH MES/document/doc2/assets/photo.png", "/DH MES/document/doc1/", "/DH MES/document/doc1/../doc2/photo.png"]) {
        const result = fixture({ owner: { attachments: [{ ...asset, storagePath }] } });
        await result.run();
        assert.deepEqual(result.deleted, []);
    }
    assert.equal(resourceKey(asset.url), resourceKey("https://dl.dropboxusercontent.com/scl/fi/photo/photo.png?dl=0"));
});

test('missing owners and non-resource selections do not scan the document corpus', async () => {
    for (const owner of [null, { attachments: [asset] }]) {
        const db = { document: { findById: () => ({ select: () => ({ lean: async () => owner }) }),
            find: () => { throw new Error('unexpected corpus read'); } },
            documentRevision: { find: () => { throw new Error('unexpected revision read'); } } };
        await cleanupDocumentResources({ documentId: 'doc1', resourceIds: ['different-asset'], db, dropbox: {} });
    }
});

test('failed document or revision scans close the cursor and cannot delete files', async () => {
    for (const failed of ['documents', 'revisions']) {
        const closed = [], reads = [];
        const query = name => ({ select() { return this; }, lean() { return this; }, cursor(options) {
            assert.equal(options.batchSize, 32);
            reads.push(name);
            return { async *[Symbol.asyncIterator]() {
                yield name === 'documents' ? { _id: 'doc1', attachments: [asset] } : {};
                if (failed === name) throw new Error('Read interrupted');
            }, async close() { closed.push(name); } };
        } });
        const db = { document: { findById: () => ({ select: () => ({ lean: async () => ({ attachments: [asset] }) }) }),
            find: () => query('documents') }, documentRevision: { find: () => query('revisions') } };
        await assert.rejects(cleanupDocumentResources({ documentId: 'doc1', resourceIds: ['resource1'], db,
            dropbox: { filesDeleteV2: () => assert.fail('incomplete reference scan must never delete') } }), /Read interrupted/);
        assert.deepEqual(closed, reads);
    }
});

test('scanning 5000 synthetic documents does not retain their bodies or text references', { timeout: 15000 }, async t => {
    const { stdout } = await require('node:util').promisify(require('node:child_process').execFile)(process.execPath,
        ['--expose-gc', path.join(__dirname, 'support/documentResourceMemory.cjs')], { timeout: 12000 });
    const result = JSON.parse(stdout.trim().split(/\r?\n/).at(-1));
    t.diagnostic(JSON.stringify(result));
    assert.equal(result.documents, 5000);
    assert.equal(result.materializedReads, 0);
    assert.equal(result.closed, 2);
    // The original implementation retained more than 52 MiB of this corpus.
    // Heap retention is the regression signal; RSS depends on the native allocator.
    assert.ok(result.heapGrowthMiB < 8, `Retained ${result.heapGrowthMiB} MiB`);
});
