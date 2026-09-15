const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');
const mongoose = require('mongoose');
const { randomUUID } = require('node:crypto');

const uri = process.env.DATA_SYNC_TEST_URI;
test('batched unread counts preserve author, status, timestamp ties and per-user read boundaries', { skip: !uri }, async t => {
    assert.match(uri, /^mongodb:\/\/(127\.0\.0\.1|localhost):\d+\/data_sync_test_[a-z\d_]+(?:\?|$)/i);
    const connection = await mongoose.createConnection(uri, { dbName: `data_sync_test_unread_${randomUUID().replaceAll('-', '')}` }).asPromise();
    t.after(async () => { await connection.dropDatabase(); await connection.close(); });
    const messages = connection.db.collection('message'), reads = connection.db.collection('messageRead');
    const userId = new mongoose.Types.ObjectId(), authorId = new mongoose.Types.ObjectId();
    const topics = Array.from({ length: 4 }, () => ({ _id: new mongoose.Types.ObjectId(), requestHash: 'private', clientRequestId: 'private', title: 'Topic' }));
    const at = new Date('2026-09-15T12:00:00Z');
    const rows = topics.slice(0, 3).flatMap(topic => Array.from({ length: 6 }, (_, index) => ({
        _id: new mongoose.Types.ObjectId(), topicId: topic._id, authorId: index === 5 ? userId : authorId,
        createdAt: index < 3 ? at : new Date(+at + 1000), status: ['Active', 'Active', 'Active', 'Deleted', 'Retracted', 'Active'][index],
    })));
    await messages.insertMany(rows);
    await reads.insertMany([
        { topicId: topics[0]._id, userId, readAt: at, messageId: rows[1]._id },
        { topicId: topics[1]._id, userId: authorId, readAt: new Date(+at + 5000), messageId: rows[8]._id },
        { topicId: topics[2]._id, userId, readAt: new Date(+at + 5000), messageId: rows[14]._id },
    ]);
    let readQueries = 0, countQueries = 0;
    const db = {
        messageRead: { find: (filter, projection) => { readQueries++; return { lean: () => reads.find(filter, { projection }).toArray() }; } },
        message: { aggregate: pipeline => { countQueries++; return messages.aggregate(pipeline).toArray(); } },
    };
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(require.resolve('../socket/messageDelivery'), 'utf8'), {
        module, require: name => name === '../models' ? db : name === './session' ? {} : name === 'mongoose' ? mongoose : require('../utils/messagePolicy'),
    });
    const { projectTopics, projectTopic } = module.exports;
    const result = await projectTopics(topics, userId);
    assert.deepEqual(Array.from(result, row => row.unreadCount), [1, 3, 0, 0]);
    assert.ok(result.every(row => !('requestHash' in row) && !('clientRequestId' in row)));
    assert.equal(readQueries, 1);
    assert.equal(countQueries, 1);
    assert.equal((await projectTopic(topics[0], userId)).unreadCount, 1);
    readQueries = countQueries = 0;
    assert.equal((await projectTopics([], userId)).length, 0);
    assert.equal(readQueries + countQueries, 0);
});
