const { createHash } = require('node:crypto');
const id = value => String(value?._id || value || '');
const objectId = value => {
    if (typeof value !== 'string' || !/^[a-f\d]{24}$/i.test(value)) throw new Error('Invalid record ID');
    return value;
};
const requestId = value => {
    if (typeof value !== 'string' || !/^[a-z\d-]{16,80}$/i.test(value)) throw new Error('Invalid request ID');
    return value;
};
const fields = (input, allowed) => {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !allowed.includes(key))) throw new Error('Unsupported request field');
};
const text = (value, maximum, required = true) => {
    if (typeof value !== 'string' || value.length > maximum || (required && !value.trim())) throw new Error('Invalid text');
    return value.trim();
};
const member = (topic, userId) => !!topic && !topic.isDeleted && topic.participants.some(value => id(value) === id(userId));
const editor = (topic, userId) => member(topic, userId) && (id(topic.creator) === id(userId) || topic.editors.some(value => id(value) === id(userId)));
const revisionFilter = value => value === 0 ? { $or: [{ revision: 0 }, { revision: { $exists: false } }] } : { revision: value };
const revision = value => {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid revision');
    return value;
};
const cleanContent = (type, content, participants, hasAttachments = false) => {
    if (type === 'Text') return text(content, 20000, !hasAttachments);
    if (type === 'Todo') {
        fields(content, ['kind', 'title', 'items']);
        if (content.kind !== 'todo' || !Array.isArray(content.items) || !content.items.length || content.items.length > 100) throw new Error('Invalid todo list');
        const items = content.items.map(item => {
            fields(item, ['id', 'text', 'assigneeId']);
            const assigneeId = item.assigneeId ? objectId(item.assigneeId) : null;
            if (assigneeId && !participants.some(value => id(value) === assigneeId)) throw new Error('Assignee must be a participant');
            return { id: requestId(item.id), text: text(item.text, 1000), assigneeId, completed: false, completedBy: null, completedAt: null };
        });
        if (new Set(items.map(item => item.id)).size !== items.length) throw new Error('Duplicate todo item');
        return { kind: 'todo', title: text(content.title || 'Todo list', 200), items };
    }
    if (type === 'Poll') {
        fields(content, ['kind', 'question', 'options', 'multiple']);
        if (content.kind !== 'poll' || typeof content.multiple !== 'boolean' || !Array.isArray(content.options) || content.options.length < 2 || content.options.length > 10) throw new Error('Invalid poll');
        const options = content.options.map(option => {
            fields(option, ['id', 'text']);
            return { id: requestId(option.id), text: text(option.text, 300) };
        });
        if (new Set(options.map(option => option.id)).size !== options.length || new Set(options.map(option => option.text.toLowerCase())).size !== options.length) throw new Error('Duplicate poll option');
        return { kind: 'poll', question: text(content.question, 500), options, multiple: content.multiple, closed: false, votes: {} };
    }
    throw new Error('Unsupported message type');
};
const summary = message => ['Retracted', 'Deleted'].includes(message.status) ? 'Message retracted'
    : String(typeof message.content === 'string' ? message.content || 'Attachment' : message.content?.title || message.content?.question || 'Message').slice(0, 200);
const projectMessage = message => {
    const { requestHash, clientRequestId, history, ...safe } = message.toObject ? message.toObject() : message;
    safe.attachments = (safe.attachments || []).map(attachment => ({ _id: attachment._id, attachmentId: attachment.attachmentId,
        type: attachment.type, filename: attachment.filename, size: attachment.size, mime: attachment.mime, ...(attachment.url ? { url: attachment.url } : {}) }));
    if (['Retracted', 'Deleted'].includes(safe.status)) { safe.content = ''; safe.attachments = []; }
    return safe;
};
const cursorFor = row => Buffer.from(JSON.stringify({ at: new Date(row.createdAt).toISOString(), id: id(row) })).toString('base64url');
const cursorFilter = cursor => {
    if (!cursor) return {};
    if (typeof cursor !== 'string' || cursor.length > 300) throw new Error('Invalid cursor');
    let value;
    try { value = JSON.parse(Buffer.from(cursor, 'base64url').toString()); } catch { throw new Error('Invalid cursor'); }
    objectId(value.id);
    if (typeof value.at !== 'string' || !Number.isFinite(Date.parse(value.at))) throw new Error('Invalid cursor');
    return { $or: [{ createdAt: { $lt: new Date(value.at) } }, { createdAt: new Date(value.at), _id: { $lt: value.id } }] };
};
const pageSize = value => Math.min(Math.max(Number.isSafeInteger(value) ? value : 50, 1), 100);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
module.exports = { id, objectId, requestId, fields, text, member, editor, revision, revisionFilter, cleanContent, summary, projectMessage, cursorFor, cursorFilter, pageSize, hash };
