const db = require('../../models');
const { getActiveSessionUser, getSessionUserId } = require('../session');
const { projectTopic, deliverTopicChange } = require('../messageDelivery');
const policy = require('../../utils/messagePolicy');
const { id, objectId, requestId, fields, text, member, editor, revision, revisionFilter, cleanContent, summary, projectMessage, cursorFor, cursorFilter, pageSize, hash } = policy;

module.exports = (socket, io) => {
    const assertSession = (user, generation) => {
        if (getSessionUserId(socket) !== id(user) || socket.data.sessionGeneration !== generation || socket.data.expiresAt <= Date.now()) throw new Error('Session changed. Sign in again.');
    };
    const context = async (topicId, manage = false) => {
        objectId(topicId);
        const user = await getActiveSessionUser(socket);
        const generation = socket.data.sessionGeneration;
        const topic = await db.topic.findById(topicId).lean();
        assertSession(user, generation);
        if (!member(topic, user._id) || (manage && !editor(topic, user._id))) throw new Error('Topic access denied');
        return { user, topic, generation };
    };
    const respond = (event, action) => socket.on(event, async (input, callback) => {
        const generation = socket.data.sessionGeneration;
        try {
            const payload = await action(input || {});
            if (generation !== socket.data.sessionGeneration || socket.data.expiresAt <= Date.now()) throw new Error('Session changed. Sign in again.');
            callback?.({ status: 'success', payload });
        } catch (error) {
            callback?.({ status: 'error', message: error.message });
        }
    });
    const validParticipants = async values => {
        if (!Array.isArray(values) || !values.length || values.length > 200) throw new Error('Select 1 to 200 participants');
        const ids = [...new Set(values.map(objectId))];
        if (await db.user.countDocuments({ _id: { $in: ids }, status: 'Active' }) !== ids.length) throw new Error('Participant account unavailable');
        return ids;
    };
    const updateSummary = async topicId => {
        const latest = await db.message.findOne({ topicId }).sort({ createdAt: -1, _id: -1 }).lean();
        if (!latest) return;
        await db.topic.updateOne({ _id: topicId, $or: [{ 'lastMessage.at': { $lte: latest.createdAt } }, { 'lastMessage.at': { $exists: false } }] }, {
            $set: { lastMessage: { content: summary(latest), by: latest.authorId, at: latest.createdAt } },
        });
    };

    respond('topic:fetch', async input => {
        fields(input, ['view', 'cursor', 'limit']);
        const user = await getActiveSessionUser(socket);
        const generation = socket.data.sessionGeneration;
        if (input.view && !['topics', 'archived'].includes(input.view)) throw new Error('Invalid topic view');
        const limit = pageSize(input.limit);
        const query = { participants: user._id, isDeleted: { $ne: true }, ...cursorFilter(input.cursor) };
        if (input.view) query.archived = input.view === 'archived' ? user._id : { $ne: user._id };
        const rows = await db.topic.find(query).sort({ createdAt: -1, _id: -1 }).limit(limit + 1).lean();
        const items = await Promise.all(rows.slice(0, limit).map(topic => projectTopic(topic, user._id)));
        assertSession(user, generation);
        for (const topic of items) (socket.data.messageTopics ||= new Set()).add(id(topic));
        return { items, nextCursor: rows.length > limit ? cursorFor(rows[limit - 1]) : null };
    });
    respond('topic:get', async input => {
        fields(input, ['_id']);
        const { topic, user, generation } = await context(input._id);
        const safe = await projectTopic(topic, user._id);
        assertSession(user, generation);
        (socket.data.messageTopics ||= new Set()).add(id(topic));
        return safe;
    });
    respond('topic:create', async input => {
        fields(input, ['title', 'description', 'participants', 'editors', 'clientRequestId']);
        const user = await getActiveSessionUser(socket);
        const generation = socket.data.sessionGeneration;
        const participants = await validParticipants([...new Set([id(user), ...(input.participants || [])])]);
        const editors = [...new Set([id(user), ...(input.editors || [])].map(objectId))];
        if (editors.some(value => !participants.includes(value))) throw new Error('Editors must be participants');
        const data = { title: text(input.title, 200), description: text(input.description, 2000), participants, editors, creator: user._id, clientRequestId: requestId(input.clientRequestId) };
        data.requestHash = hash(data);
        assertSession(user, generation);
        const key = { creator: user._id, clientRequestId: data.clientRequestId };
        let topic;
        try {
            topic = await db.topic.findOneAndUpdate(key, { $setOnInsert: data }, { upsert: true, new: true, runValidators: true }).lean();
        } catch (error) {
            if (error.code !== 11000) throw error;
            topic = await db.topic.findOne(key).lean();
        }
        if (!topic || topic.requestHash !== data.requestHash) throw new Error('This request ID belongs to another topic request');
        const safe = await projectTopic(topic, user._id);
        assertSession(user, generation);
        (socket.data.messageTopics ||= new Set()).add(id(topic));
        return safe;
    });
    respond('topic:update', async input => {
        fields(input, ['_id', 'revision', 'title', 'description', 'deadline', 'participants', 'editors']);
        const { user, topic, generation } = await context(input._id, true);
        const patch = {};
        if ('title' in input) patch.title = text(input.title, 200);
        if ('description' in input) patch.description = text(input.description, 2000);
        if ('deadline' in input) {
            if (input.deadline !== '' && (!/^\d{4}-\d{2}-\d{2}$/.test(input.deadline) || new Date(input.deadline).toISOString().slice(0, 10) !== input.deadline)) throw new Error('Invalid deadline');
            patch.deadline = input.deadline;
        }
        if ('participants' in input || 'editors' in input) {
            patch.participants = await validParticipants(input.participants || topic.participants.map(id));
            if (!patch.participants.includes(id(topic.creator))) throw new Error('The creator must remain a participant');
            patch.editors = [...new Set((input.editors || topic.editors.map(id)).map(objectId))];
            if (!patch.editors.includes(id(topic.creator)) || patch.editors.some(value => !patch.participants.includes(value))) throw new Error('Editors must include the creator and belong to this topic');
        }
        assertSession(user, generation);
        const saved = await db.topic.findOneAndUpdate({ _id: topic._id, ...revisionFilter(revision(input.revision)) }, { $set: patch, $inc: { revision: 1 } }, { new: true, runValidators: true }).lean();
        if (!saved) throw new Error('Topic changed. Refresh before saving again.');
        return projectTopic(saved, user._id);
    });
    for (const [event, field] of [['topic:pin', 'pinned'], ['topic:archive', 'archived']]) respond(event, async input => {
        fields(input, ['_id', field]);
        if (typeof input[field] !== 'boolean') throw new Error('Invalid preference');
        const { topic, user, generation } = await context(input._id);
        assertSession(user, generation);
        const operation = input[field] ? '$addToSet' : '$pull';
        const saved = await db.topic.findOneAndUpdate({ _id: topic._id }, { [operation]: { [field]: user._id } }, { new: true }).lean();
        return projectTopic(saved, user._id);
    });
    respond('topic:delete', async input => {
        fields(input, ['_id', 'revision']);
        const { user, topic, generation } = await context(input._id, true);
        assertSession(user, generation);
        const saved = await db.topic.findOneAndUpdate({ _id: topic._id, ...revisionFilter(revision(input.revision)) }, { $set: { isDeleted: true }, $inc: { revision: 1 } }, { new: true }).lean();
        if (!saved) throw new Error('Topic changed. Refresh before removing it.');
        await deliverTopicChange(io, saved);
        return { _id: id(topic) };
    });

    respond('message:fetch', async input => {
        fields(input, ['topicId', 'before', 'limit']);
        const { topic, user, generation } = await context(input.topicId);
        const limit = pageSize(input.limit);
        const rows = await db.message.find({ topicId: topic._id, ...cursorFilter(input.before) }).sort({ createdAt: -1, _id: -1 }).limit(limit + 1).lean();
        assertSession(user, generation);
        return { items: rows.slice(0, limit).reverse().map(projectMessage), nextCursor: rows.length > limit ? cursorFor(rows[limit - 1]) : null };
    });
    respond('message:create', async input => {
        fields(input, ['topicId', 'clientRequestId', 'type', 'content', 'attachments']);
        const { topic, user, generation } = await context(input.topicId);
        const attachmentIds = input.attachments || [];
        if (!Array.isArray(attachmentIds) || attachmentIds.length > 10 || new Set(attachmentIds).size !== attachmentIds.length) throw new Error('Invalid attachments');
        attachmentIds.forEach(objectId);
        const attachments = attachmentIds.length ? await db.messageAttachment.find({ _id: { $in: attachmentIds }, topicId: topic._id, ownerId: user._id, status: { $in: ['Ready', 'Attached'] } }).lean() : [];
        if (attachments.length !== attachmentIds.length) throw new Error('Attachment upload is incomplete or unavailable');
        const clientRequestId = requestId(input.clientRequestId);
        if (attachments.some(file => file.messageRequestId && file.messageRequestId !== clientRequestId)) throw new Error('Attachment belongs to another message');
        const content = cleanContent(input.type, input.content, topic.participants, attachments.length > 0);
        const requestHash = hash({ topicId: id(topic), type: input.type, content, attachments: [...attachmentIds].sort() });
        const data = { topicId: topic._id, authorId: user._id, clientRequestId, requestHash, type: input.type, content,
            attachments: attachments.map(file => ({ attachmentId: file._id, filename: file.filename, type: file.type, mime: file.mime, size: file.size })) };
        const key = { authorId: user._id, clientRequestId };
        assertSession(user, generation);
        for (const file of attachments) {
            const claimed = await db.messageAttachment.updateOne({ _id: file._id, ownerId: user._id, status: { $in: ['Ready', 'Attached'] },
                $or: [{ messageRequestId: { $exists: false } }, { messageRequestId: clientRequestId }] }, { $set: { messageRequestId: clientRequestId, expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) } });
            if (!claimed.matchedCount) throw new Error('Attachment belongs to another message');
        }
        let message;
        try {
            message = await db.message.findOneAndUpdate(key, { $setOnInsert: data }, { upsert: true, new: true, runValidators: true }).lean();
        } catch (error) {
            if (error.code !== 11000) throw error;
            message = await db.message.findOne(key).lean();
        }
        if (!message || message.requestHash !== requestHash) throw new Error('This request ID belongs to another message');
        if (attachments.length) await db.messageAttachment.updateMany({ _id: { $in: attachmentIds }, ownerId: user._id }, { $set: { status: 'Attached', messageId: message._id, messageRequestId: clientRequestId }, $unset: { expiresAt: '' } });
        await updateSummary(topic._id);
        assertSession(user, generation);
        return projectMessage(message);
    });

    const messageContext = async messageId => {
        objectId(messageId);
        const user = await getActiveSessionUser(socket);
        const generation = socket.data.sessionGeneration;
        const message = await db.message.findById(messageId).lean();
        if (!message) throw new Error('Message unavailable');
        const topic = await db.topic.findById(message.topicId).lean();
        assertSession(user, generation);
        if (!member(topic, user._id)) throw new Error('Message access denied');
        return { user, topic, message, generation };
    };
    respond('message:get', async input => {
        fields(input, ['_id']);
        const { message } = await messageContext(input._id);
        return projectMessage(message);
    });
    for (const event of ['message:edit', 'message:retract', 'message:restore']) respond(event, async input => {
        fields(input, ['_id', 'revision', ...(event === 'message:edit' ? ['content'] : [])]);
        const { user, topic, message, generation } = await messageContext(input._id);
        if (id(message.authorId) !== id(user)) throw new Error('Only the author can change this message');
        const patch = {};
        if (event === 'message:edit') {
            if (message.type !== 'Text' || ['Retracted', 'Deleted'].includes(message.status)) throw new Error('Only active text messages can be edited');
            patch.content = cleanContent('Text', input.content, topic.participants, message.attachments?.length > 0);
            patch.status = 'Modified';
        } else {
            if (event === 'message:restore' && message.status !== 'Retracted') throw new Error('Message is not retracted');
            patch.status = event === 'message:retract' ? 'Retracted' : 'Active';
        }
        assertSession(user, generation);
        const saved = await db.message.findOneAndUpdate({ _id: message._id, ...revisionFilter(revision(input.revision)) }, {
            $set: patch, $inc: { revision: 1 }, $push: { history: { content: message.content, status: message.status, by: user._id, at: new Date() } },
        }, { new: true, runValidators: true }).lean();
        if (!saved) throw new Error('Message changed. Refresh before saving again.');
        await updateSummary(topic._id);
        return projectMessage(saved);
    });
    respond('message:delete', async () => { throw new Error('Use retract to preserve the message audit trail'); });

    respond('message:todo', async input => {
        fields(input, ['_id', 'itemId', 'completed', 'revision']);
        const { user, topic, message, generation } = await messageContext(input._id);
        if (message.type !== 'Todo' || message.content?.kind !== 'todo' || ['Retracted', 'Deleted'].includes(message.status)) throw new Error('Todo unavailable');
        if (typeof input.completed !== 'boolean') throw new Error('Invalid completion state');
        const index = message.content.items.findIndex(item => item.id === input.itemId);
        if (index < 0) throw new Error('Todo item unavailable');
        const item = message.content.items[index];
        if (item.assigneeId && id(item.assigneeId) !== id(user) && !editor(topic, user._id)) throw new Error('Only the assignee or topic editor can complete this item');
        const prefix = `content.items.${index}`;
        assertSession(user, generation);
        const saved = await db.message.findOneAndUpdate({ _id: message._id, ...revisionFilter(revision(input.revision)) }, {
            $set: { [`${prefix}.completed`]: input.completed, [`${prefix}.completedBy`]: input.completed ? user._id : null, [`${prefix}.completedAt`]: input.completed ? new Date() : null }, $inc: { revision: 1 },
        }, { new: true }).lean();
        if (!saved) throw new Error('Todo changed. Review its current state and try again.');
        return projectMessage(saved);
    });
    respond('message:vote', async input => {
        fields(input, ['_id', 'optionIds']);
        const { user, message, generation } = await messageContext(input._id);
        if (message.type !== 'Poll' || message.content?.kind !== 'poll' || message.content.closed || ['Retracted', 'Deleted'].includes(message.status)) throw new Error('Poll is closed or unavailable');
        const options = input.optionIds;
        if (!Array.isArray(options) || options.length > 10 || new Set(options).size !== options.length || (!message.content.multiple && options.length > 1) || options.some(option => !message.content.options.some(value => value.id === option))) throw new Error('Invalid poll choices');
        assertSession(user, generation);
        const saved = await db.message.findOneAndUpdate({ _id: message._id, 'content.closed': false, status: { $nin: ['Retracted', 'Deleted'] } }, {
            $set: { [`content.votes.${id(user)}`]: options }, $inc: { revision: 1 },
        }, { new: true }).lean();
        if (!saved) throw new Error('Poll closed before this vote was saved');
        return projectMessage(saved);
    });
    respond('message:pollClose', async input => {
        fields(input, ['_id', 'closed']);
        const { user, topic, message, generation } = await messageContext(input._id);
        if (message.type !== 'Poll' || message.content?.kind !== 'poll' || typeof input.closed !== 'boolean' || (id(message.authorId) !== id(user) && !editor(topic, user._id))) throw new Error('Poll management denied');
        assertSession(user, generation);
        const saved = await db.message.findOneAndUpdate({ _id: message._id }, { $set: { 'content.closed': input.closed }, $inc: { revision: 1 } }, { new: true }).lean();
        return projectMessage(saved);
    });
    respond('topic:read', async input => {
        fields(input, ['topicId', 'messageId']);
        const { topic, user, generation } = await context(input.topicId);
        const message = await db.message.findOne({ _id: objectId(input.messageId), topicId: topic._id }).lean();
        if (!message) throw new Error('Read position unavailable');
        const key = { topicId: topic._id, userId: user._id };
        assertSession(user, generation);
        try { await db.messageRead.updateOne(key, { $setOnInsert: key }, { upsert: true }); } catch (error) { if (error.code !== 11000) throw error; }
        await db.messageRead.updateOne({ ...key, $or: [{ readAt: { $exists: false } }, { readAt: { $lt: message.createdAt } }, { readAt: message.createdAt, messageId: { $lt: message._id } }] }, {
            $set: { messageId: message._id, readAt: message.createdAt },
        });
        await deliverTopicChange(io, topic);
        return projectTopic(topic, user._id);
    });
};
