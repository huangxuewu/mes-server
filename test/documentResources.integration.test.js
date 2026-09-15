const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const Y = require('yjs');
const { cleanupDocumentResources } = require('../utils/documentResources');

test('real Mongo cursors preserve revision and collaboration references while cleaning unused resources', {
    skip: !process.env.DOCUMENT_RESOURCE_TEST_URI, timeout: 15000,
}, async () => {
    const uri = process.env.DOCUMENT_RESOURCE_TEST_URI;
    assert.match(uri, /^mongodb:\/\/127\.0\.0\.1:\d+\/document_resource_test_[a-z0-9_]+$/,
        'integration fixture must use a named disposable local database');
    const connection = await mongoose.createConnection(uri).asPromise();
    const shared = new Y.Doc();
    try {
        const Document = connection.model('ResourceDocument', new mongoose.Schema({
            attachments: [mongoose.Schema.Types.Mixed], contentJson: mongoose.Schema.Types.Mixed,
            formSchema: mongoose.Schema.Types.Mixed, thumbnail: mongoose.Schema.Types.Mixed,
            yjsState: { type: Buffer, select: false },
        }, { timestamps: true }));
        const Revision = connection.model('ResourceRevision', new mongoose.Schema({
            contentJson: mongoose.Schema.Types.Mixed, formSchema: mongoose.Schema.Types.Mixed, artifacts: [mongoose.Schema.Types.Mixed],
        }, { timestamps: true }));
        const ownerId = new mongoose.Types.ObjectId();
        const assets = ['revision', 'persisted', 'live', 'unused'].map(name => ({
            _id: name, purpose: 'resource', url: `https://example.test/${name}.png`,
            storagePath: `/DH MES/document/${ownerId}/assets/${name}.png`,
        }));
        const persisted = new Y.Doc(), node = new Y.XmlElement('image');
        node.setAttribute('src', assets[1].url); persisted.getXmlFragment('default').insert(0, [node]);
        const yjsState = Buffer.from(Y.encodeStateAsUpdate(persisted)); persisted.destroy();
        const liveNode = new Y.XmlElement('image');
        liveNode.setAttribute('src', assets[2].url); shared.getXmlFragment('default').insert(0, [liveNode]);
        await Document.create({ _id: ownerId, attachments: assets, yjsState });
        await Document.insertMany(Array.from({ length: 70 }, (_, index) => ({ contentJson: { text: `Unrelated document ${index}` } })));
        await Revision.create({ artifacts: [{ url: assets[0].url }] });
        const deleted = [];
        await cleanupDocumentResources({ documentId: ownerId, resourceIds: assets.map(asset => asset._id),
            db: { document: Document, documentRevision: Revision }, liveDocuments: new Map([['live', shared]]),
            dropbox: { filesGetMetadata: async () => ({ result: { '.tag': 'file' } }),
                filesDeleteV2: async ({ path }) => deleted.push(path) },
        });
        assert.deepEqual(deleted, [assets[3].storagePath]);
        const saved = await Document.findById(ownerId).lean();
        assert.deepEqual(saved.attachments.map(asset => asset._id), ['revision', 'persisted', 'live']);
    } finally {
        shared.destroy();
        await connection.dropDatabase();
        await connection.close();
    }
});
