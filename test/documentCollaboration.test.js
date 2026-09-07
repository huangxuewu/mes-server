const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const mongoose = require("mongoose");
const Y = require("yjs");

const connection = new mongoose.Mongoose();
const Record = connection.model("CollaborationRecord", new connection.Schema({ yjsState: Buffer }));

const fixture = () => {
    let storedRecord = {};
    const listeners = {};
    const db = {
        document: {
            findById: () => ({ select: () => ({
                lean: async () => storedRecord,
                then: (resolve, reject) => Promise.resolve(Record.hydrate(storedRecord)).then(resolve, reject),
            }) }),
            updateOne: async (filter, update) => {
                storedRecord = mongoose.mongo.BSON.deserialize(mongoose.mongo.BSON.serialize({
                    yjsState: update.$set.yjsState,
                }));
            },
        },
    };
    const context = {
        module: { exports: {} },
        Buffer,
        require: (name) => {
            if (name === "../models") return db;
            if (name === "./session") return {
                onSessionEnded: callback => { listeners.sessionEnded = callback; },
                onPermissionsChanged: callback => { listeners.permissionsChanged = callback; },
            };
            if (name === "@hocuspocus/server") return { Hocuspocus: class {
                constructor(hooks) { Object.assign(this, hooks); this.documents = new Map(); }
                closeConnections() {}
                flushPendingStores() {}
                async unloadDocument(document) { try { await this.beforeUnloadDocument({document}); } catch { return; } this.documents.delete(document.name); }
            } };
            return require(name);
        },
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../socket/collaboration.js"), "utf8"), context);
    return { hooks: context.module.exports.collaboration, freeze: context.module.exports.freezeDocument, stored: () => storedRecord, listeners };
};

test('permission changes close only the affected sockets document connections for access revalidation', () => {
    const { hooks, listeners } = fixture();
    const closed = [];
    const connection = (socketId, label) => ({ context: { socketId }, close: () => closed.push(label) });
    hooks.documents.set('one', { connections: new Map([
        [connection('changed', 'first'), {}], [connection('other', 'unaffected'), {}],
    ]) });
    hooks.documents.set('two', { connections: new Map([[connection('changed', 'second'), {}]]) });
    listeners.permissionsChanged('changed');
    assert.deepEqual(closed, ['first', 'second']);
});

test("saved collaboration state restores MongoDB binary data and comment text identities", async () => {
    const { hooks, stored } = fixture();
    const original = new Y.Doc();
    const paragraph = new Y.XmlElement("paragraph");
    const text = new Y.XmlText();
    original.getXmlFragment("default").insert(0, [paragraph]);
    paragraph.insert(0, [text]);
    text.insert(0, "A saved comment reference");
    const anchor = Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, 8));

    await hooks.onStoreDocument({ documentName: "doc1", document: original, lastContext: {} });
    assert.equal(stored().yjsState._bsontype, "Binary");
    const restored = new Y.Doc();
    await hooks.onLoadDocument({ documentName: "doc1", document: restored });
    assert.equal(restored.getXmlFragment("default").toString(), original.getXmlFragment("default").toString());
    const position = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(anchor), restored);
    assert.equal(position.index, 8);
    assert.equal(position.type.toString().slice(position.index, position.index + 7), "comment");

    position.type.insert(0, "Edited ");
    await hooks.onStoreDocument({ documentName: "doc1", document: restored, lastContext: {} });
    const reopened = new Y.Doc();
    await hooks.onLoadDocument({ documentName: "doc1", document: reopened });
    const moved = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(anchor), reopened);
    assert.equal(moved.index, 15);
    assert.equal(moved.type.toString().slice(moved.index, moved.index + 7), "comment");
    original.destroy();
    restored.destroy();
    reopened.destroy();
});

test("documents without collaboration state can initialize normally", async () => {
    const { hooks } = fixture();
    const document = new Y.Doc();
    await hooks.onLoadDocument({ documentName: "new", document });
    assert.equal(document.getXmlFragment("default").length, 0);
    document.destroy();
});

test('locking snapshots live text and marks and prevents a delayed collaborative store', async () => {
    const { hooks, freeze, stored } = fixture();
    const document = new Y.Doc(); document.name = 'lock-test';
    const paragraph = new Y.XmlElement('paragraph'), text = new Y.XmlText();
    document.getXmlFragment('default').insert(0, [paragraph]); paragraph.insert(0, [text]);
    text.insert(0, 'Latest unsaved text', { bold: {} }); hooks.documents.set(document.name, document);
    const frozen = await freeze(document.name);
    const { snapshot } = frozen;
    assert.equal(hooks.documents.has(document.name), true);
    await hooks.unloadDocument(document);
    assert.equal(hooks.documents.has(document.name), true);
    await frozen.commit();
    assert.equal(snapshot.contentJson.content[0].content[0].text, 'Latest unsaved text');
    assert.equal(snapshot.contentJson.content[0].content[0].marks[0].type, 'bold');
    assert.equal(snapshot.plainText, 'Latest unsaved text'); assert.ok(snapshot.yjsState.length);
    assert.equal(hooks.documents.has(document.name), false);
    await hooks.onStoreDocument({ documentName: document.name, document, lastContext: {} });
    assert.equal(stored().yjsState, undefined); document.destroy();
});


test('a failed settings save retains live text, connections and subsequent stores', async () => {
 const {hooks,freeze,stored}=fixture();
 const document=new Y.Doc();document.name='failed-settings';
 const paragraph=new Y.XmlElement('paragraph'),text=new Y.XmlText();
 document.getXmlFragment('default').insert(0,[paragraph]);paragraph.insert(0,[text]);text.insert(0,'Saved');
 await hooks.onStoreDocument({documentName:document.name,document,lastContext:{}});
 text.insert(text.length,' and latest edits');hooks.documents.set(document.name,document);
 let closed=false;hooks.closeConnections=()=>{closed=true;};
 const frozen=await freeze(document.name);
 await hooks.unloadDocument(document);
 assert.equal(hooks.documents.get(document.name),document);assert.equal(closed,false);
 frozen.rollback();
 assert.equal(document.fileSettingsPending,false);assert.ok(!document.fileSettingsFrozen);
 await hooks.onStoreDocument({documentName:document.name,document,lastContext:{}});
 const reopened=new Y.Doc();Y.applyUpdate(reopened,new Uint8Array(stored().yjsState.buffer));
 assert.equal(reopened.getXmlFragment('default').toString(),'<paragraph>Saved and latest edits</paragraph>');
 document.destroy();reopened.destroy();
});
