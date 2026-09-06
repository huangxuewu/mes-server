const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const mongoose = require('mongoose');
const test = require('node:test');
const assert = require('node:assert/strict');
const { ids } = require('./support/messageFixture');

test('real Mongoose schemas validate private attachments and keep idempotency indexes partial for legacy records', async t => {
    const connection = mongoose.createConnection();
    connection.config.autoCreate = false;
    connection.config.autoIndex = false;
    t.after(() => connection.destroy());
    const models = {};
    const database = { model: (name, schema, collection) => {
        const model = connection.model(name, schema, collection);
        model.watch = () => new EventEmitter();
        return model;
    } };
    for (const file of ['message', 'topic', 'messageRead', 'messageAttachment']) {
        const module = { exports: {} };
        vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../models', `${file}.js`), 'utf8'), { module, exports: module.exports, console,
            require: name => {
                if (name === 'mongoose') return mongoose;
                if (name === '../config/database') return database;
                if (name === '../socket/io') return { io: {} };
                if (name === '../socket/messageDelivery') return { deliverMessageChange() {}, deliverTopicChange() {} };
                throw new Error(`Unexpected model dependency ${name}`);
            } });
        models[file] = module.exports;
    }
    const message = new models.message({ topicId: ids.topic, authorId: ids.a, type: 'Text', content: '',
        attachments: [{ attachmentId: ids.b, type: 'Document', filename: 'shift.txt', mime: 'text/plain', size: 6 }] });
    assert.equal(message.validateSync(), undefined);
    assert.equal(message.attachments[0].url, undefined);
    assert.equal(message.revision, 0);
    const invalid = new models.message({ topicId: ids.topic, authorId: ids.a, type: 'text', content: 'Wrong enum' });
    assert.ok(invalid.validateSync().errors.type);
    const messageIndex = models.message.schema.indexes().find(([fields]) => fields.authorId && fields.clientRequestId);
    assert.equal(messageIndex[1].unique, true);
    assert.equal(messageIndex[1].partialFilterExpression.clientRequestId.$type, 'string');
    assert.ok(models.message.schema.indexes().some(([fields]) => fields.topicId && fields.createdAt === -1 && fields._id === -1));
    assert.ok(models.messageRead.schema.indexes().some(([fields, options]) => fields.topicId && fields.userId && options.unique));
});
