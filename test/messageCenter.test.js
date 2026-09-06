const assert = require('node:assert/strict');
const test = require('node:test');
const { randomUUID } = require('node:crypto');
const { fixture } = require('./support/messageFixture');
const policy = require('../utils/messagePolicy');
const send = (topicId, content = 'Inspect guard', type = 'Text') => ({ topicId, content, type, clientRequestId: randomUUID(), attachments: [] });
const success = result => { assert.equal(result.status, 'success', result.message); return result.payload; };

test('message endpoints reject anonymous, outsider and spoofed-author requests before writes', async () => {
    const { db, connect, ids } = fixture();
    const anonymous = connect(null), outsider = connect(ids.outsider), member = connect(ids.a);
    assert.equal((await anonymous.call('topic:fetch', {})).status, 'error');
    assert.equal((await outsider.call('message:fetch', { topicId: ids.topic })).status, 'error');
    assert.equal((await outsider.call('message:create', send(ids.topic))).status, 'error');
    assert.equal((await member.call('message:create', { ...send(ids.topic), authorId: ids.b })).status, 'error');
    assert.equal((await member.call('topic:fetch', { $where: 'bad' })).status, 'error');
    assert.equal(db.message.writes.length, 0);
});

test('create retries repair partial topic-summary failure without duplicate messages', async () => {
    const { db, connect, ids } = fixture();
    const actor = connect(ids.a), payload = send(ids.topic);
    db.topic.failNextUpdate = true;
    assert.equal((await actor.call('message:create', payload)).status, 'error');
    assert.equal(db.message.rows.length, 1);
    const saved = success(await actor.call('message:create', payload));
    assert.equal(db.message.rows.length, 1);
    assert.equal(saved.authorId, ids.a);
    assert.equal(db.topic.rows[0].lastMessage.content, 'Inspect guard');
    assert.equal(saved.requestHash, undefined);
    assert.equal(saved.history, undefined);
    assert.equal((await actor.call('message:create', { ...payload, content: 'Different content' })).status, 'error');
});

test('concurrent sends with one request ID return one canonical message', async () => {
    const { db, connect, ids } = fixture();
    const actor = connect(ids.a), payload = send(ids.topic);
    const results = await Promise.all([actor.call('message:create', payload), actor.call('message:create', payload)]);
    assert.equal(success(results[0])._id, success(results[1])._id);
    assert.equal(db.message.rows.length, 1);
});

test('pins are independent per user and stale metadata cannot overwrite a newer revision', async () => {
    const { db, connect, ids } = fixture();
    const a = connect(ids.a), b = connect(ids.b);
    await Promise.all([a.call('topic:pin', { _id: ids.topic, pinned: true }).then(success), b.call('topic:pin', { _id: ids.topic, pinned: true }).then(success)]);
    assert.deepEqual(db.topic.rows[0].pinned.sort(), [ids.a, ids.b].sort());
    success(await a.call('topic:update', { _id: ids.topic, revision: 0, title: 'Updated' }));
    assert.equal((await a.call('topic:update', { _id: ids.topic, revision: 0, title: 'Stale' })).status, 'error');
    assert.equal((await b.call('topic:update', { _id: ids.topic, revision: 1, title: 'Not editor' })).status, 'error');
    assert.equal(db.topic.rows[0].title, 'Updated');
    assert.equal((await a.call('topic:update', { _id: ids.topic, revision: 1, participants: [ids.b], editors: [ids.b] })).status, 'error');
});

test('structured todo summaries persist, only assignee or topic editors complete assigned items', async () => {
    const { connect, ids, db } = fixture();
    const a = connect(ids.a), b = connect(ids.b);
    const itemId = randomUUID();
    const todo = success(await a.call('message:create', send(ids.topic, { kind: 'todo', title: 'Shift checks', items: [{ id: itemId, text: 'Inspect guard', assigneeId: ids.a }] }, 'Todo')));
    assert.equal(db.topic.rows[0].lastMessage.content, 'Shift checks');
    assert.equal((await b.call('message:todo', { _id: todo._id, itemId, completed: true, revision: 0 })).status, 'error');
    const completed = success(await a.call('message:todo', { _id: todo._id, itemId, completed: true, revision: 0 }));
    assert.equal(completed.content.items[0].completedBy, ids.a);
    assert.equal((await a.call('message:todo', { _id: todo._id, itemId, completed: false, revision: 0 })).status, 'error');
});

test('concurrent poll votes retain each voter and closing rejects later votes', async () => {
    const { connect, ids, db } = fixture();
    const a = connect(ids.a), b = connect(ids.b), first = randomUUID(), second = randomUUID();
    const poll = success(await a.call('message:create', send(ids.topic, { kind: 'poll', question: 'Which shift?', multiple: false, options: [{ id: first, text: 'Morning' }, { id: second, text: 'Evening' }] }, 'Poll')));
    await Promise.all([a.call('message:vote', { _id: poll._id, optionIds: [first] }).then(success), b.call('message:vote', { _id: poll._id, optionIds: [second] }).then(success)]);
    assert.deepEqual(db.message.rows[0].content.votes[ids.a], [first]);
    assert.deepEqual(db.message.rows[0].content.votes[ids.b], [second]);
    assert.equal((await b.call('message:vote', { _id: poll._id, optionIds: [first, second] })).status, 'error');
    success(await a.call('message:pollClose', { _id: poll._id, closed: true }));
    assert.equal((await b.call('message:vote', { _id: poll._id, optionIds: [first] })).status, 'error');
});

test('pagination is stable at equal timestamps and read cursors never move backwards', async () => {
    const { connect, ids, db } = fixture();
    const a = connect(ids.a), b = connect(ids.b);
    for (let index = 1; index <= 7; index++) db.message.rows.push({ _id: index.toString(16).padStart(24, '0'), topicId: ids.topic, authorId: ids.a, type: 'Text', content: `Message ${index}`, status: 'Active', createdAt: new Date('2026-01-03'), revision: 0 });
    const first = success(await b.call('message:fetch', { topicId: ids.topic, limit: 3 }));
    const next = success(await b.call('message:fetch', { topicId: ids.topic, limit: 3, before: first.nextCursor }));
    assert.deepEqual(Array.from(first.items, item => item.content), ['Message 5', 'Message 6', 'Message 7']);
    assert.deepEqual(Array.from(next.items, item => item.content), ['Message 2', 'Message 3', 'Message 4']);
    const read = success(await b.call('topic:read', { topicId: ids.topic, messageId: first.items.at(-1)._id }));
    assert.equal(read.unreadCount, 0);
    success(await b.call('topic:read', { topicId: ids.topic, messageId: next.items[0]._id }));
    assert.equal(db.messageRead.rows[0].messageId, first.items.at(-1)._id);
});

test('retract keeps audit history while hiding content and files from projections', async () => {
    const { connect, ids, db } = fixture();
    const a = connect(ids.a), b = connect(ids.b);
    const message = success(await a.call('message:create', send(ids.topic, 'Original text')));
    assert.equal((await b.call('message:edit', { _id: message._id, revision: 0, content: 'Spoofed' })).status, 'error');
    const retracted = success(await a.call('message:retract', { _id: message._id, revision: 0 }));
    assert.equal(retracted.content, '');
    assert.equal(db.message.rows[0].content, 'Original text');
    assert.equal(db.message.rows[0].history.length, 1);
    const restored = success(await a.call('message:restore', { _id: message._id, revision: retracted.revision }));
    assert.equal(restored.content, 'Original text');
});

test('live delivery excludes outsiders, anonymous sockets and removed participants', async () => {
    const { connect, ids, db, load, io } = fixture();
    const a = connect(ids.a), b = connect(ids.b), outsider = connect(ids.outsider), anonymous = connect(null);
    const delivery = load('socket/messageDelivery.js');
    await delivery.deliverTopicChange(io, db.topic.rows[0]);
    assert.equal(a.received.length, 1);
    assert.equal(b.received.length, 1);
    assert.equal(outsider.received.length, 0);
    assert.equal(anonymous.received.length, 0);
    db.topic.rows[0].participants = [ids.a];
    await delivery.deliverTopicChange(io, db.topic.rows[0]);
    assert.equal(b.received.at(-1).event, 'topic:delete');
    const before = b.received.length;
    await delivery.deliverMessageChange(io, { _id: '111111111111111111111111', topicId: ids.topic, content: 'Private', authorId: ids.a });
    assert.equal(b.received.length, before);
    assert.equal(outsider.received.length, 0);
});

test('attachment upload acknowledges bytes, supports retry and requires membership to open', async () => {
    const { connect, ids, db, files } = fixture();
    const a = connect(ids.a), b = connect(ids.b), outsider = connect(ids.outsider);
    const stage = success(await a.call('messageAttachment:stage', { topicId: ids.topic, clientRequestId: randomUUID(), filename: 'evidence.txt', mime: 'text/plain', size: 6 }));
    const first = success(await a.call('messageAttachment:chunk', { _id: stage._id, offset: 0, contents: Buffer.from('abc') }));
    assert.equal(first.offset, 3);
    assert.equal(success(await a.call('messageAttachment:chunk', { _id: stage._id, offset: 0, contents: Buffer.from('abc') })).offset, 3);
    const ready = success(await a.call('messageAttachment:chunk', { _id: stage._id, offset: 3, contents: Buffer.from('def') }));
    assert.equal(ready.status, 'Ready');
    assert.equal([...files.values()][0].toString(), 'abcdef');
    const message = success(await a.call('message:create', { ...send(ids.topic, ''), attachments: [stage._id] }));
    assert.equal(message.attachments[0].url, undefined);
    assert.equal(db.messageAttachment.rows[0].status, 'Attached');
    assert.match(success(await b.call('messageAttachment:open', { _id: stage._id })).url, /^https:/);
    assert.equal((await outsider.call('messageAttachment:open', { _id: stage._id })).status, 'error');
    success(await a.call('message:retract', { _id: message._id, revision: 0 }));
    assert.equal((await b.call('messageAttachment:open', { _id: stage._id })).status, 'error');
});

test('content validation rejects unknown keys, duplicate options and invalid cursors', () => {
    assert.throws(() => policy.cleanContent('Poll', { kind: 'poll', question: 'Shift?', options: [{ id: randomUUID(), text: 'Same' }, { id: randomUUID(), text: 'same' }], multiple: false }, []), /Duplicate/);
    assert.throws(() => policy.cursorFilter('not-json'), /cursor/);
    assert.throws(() => policy.cleanContent('Text', { $set: 'unsafe' }, []), /text/);
});

test('upload completion retries recover a file committed before its database acknowledgement failed', async () => {
    const { connect, ids, db, dropbox, files } = fixture();
    const actor = connect(ids.a);
    const stageInput = { topicId: ids.topic, clientRequestId: randomUUID(), filename: 'evidence.txt', mime: 'text/plain', size: 6 };
    const stage = success(await actor.call('messageAttachment:stage', stageInput));
    const finish = dropbox.filesUploadSessionFinish;
    dropbox.filesUploadSessionFinish = async input => { const result = await finish(input); db.messageAttachment.failNextUpdate = true; return result; };
    const chunk = { _id: stage._id, offset: 0, contents: Buffer.from('abcdef') };
    assert.equal((await actor.call('messageAttachment:chunk', chunk)).status, 'error');
    assert.equal(files.size, 1);
    success(await actor.call('messageAttachment:stage', stageInput));
    const recovered = success(await actor.call('messageAttachment:chunk', chunk));
    assert.equal(recovered.status, 'Ready');
    assert.equal(files.size, 1);
});

test('session changes during topic loading reject the pending write', async () => {
    const { connect, ids, db } = fixture();
    const actor = connect(ids.a);
    let release;
    db.topic.findById = () => ({ lean: () => new Promise(resolve => release = () => resolve(structuredClone(db.topic.rows[0]))) });
    const pending = actor.call('message:create', send(ids.topic));
    for (let count = 0; count < 10 && !release; count++) await Promise.resolve();
    assert.ok(release);
    actor.socket.data.userId = ids.outsider;
    actor.socket.data.sessionGeneration++;
    release();
    assert.equal((await pending).status, 'error');
    assert.equal(db.message.writes.length, 0);
});

test('expired upload cleanup preserves committed-message attachments and retries storage failures', async () => {
    const { db, dropbox, ids, files } = fixture();
    const { cleanupMessageAttachments } = require('../utils/messageAttachmentCleanup');
    const expired = new Date('2026-01-01');
    db.messageAttachment.rows.push({ _id: '111111111111111111111111', ownerId: ids.a, topicId: ids.topic, expiresAt: expired, status: 'Ready', storagePath: '/unused.txt' },
        { _id: '222222222222222222222222', ownerId: ids.a, topicId: ids.topic, expiresAt: expired, status: 'Ready', storagePath: '/used.txt' });
    db.message.rows.push({ _id: '333333333333333333333333', status: 'Retracted', clientRequestId: randomUUID(), attachments: [{ attachmentId: '222222222222222222222222' }] });
    files.set('/unused.txt', Buffer.from('unused')); files.set('/used.txt', Buffer.from('audit evidence'));
    const remove = dropbox.filesDeleteV2;
    dropbox.filesDeleteV2 = async () => { throw new Error('Storage offline'); };
    await cleanupMessageAttachments({ db, dropbox, now: new Date('2026-09-06') });
    assert.equal(db.messageAttachment.rows[0].status, 'Removed');
    assert.equal(db.messageAttachment.rows[1].status, 'Attached');
    assert.equal(files.size, 2);
    dropbox.filesDeleteV2 = remove;
    const result = await cleanupMessageAttachments({ db, dropbox, now: new Date('2026-09-06') });
    assert.equal(result.removed, 1);
    assert.equal(files.has('/used.txt'), true);
    assert.equal(db.messageAttachment.rows.length, 1);
});
