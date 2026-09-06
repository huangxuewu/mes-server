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
            if (name === "./session") return {};
            if (name === "@hocuspocus/server") return { Hocuspocus: class {
                constructor(hooks) { Object.assign(this, hooks); }
            } };
            return require(name);
        },
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../socket/collaboration.js"), "utf8"), context);
    return { hooks: context.module.exports.collaboration, stored: () => storedRecord };
};

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
