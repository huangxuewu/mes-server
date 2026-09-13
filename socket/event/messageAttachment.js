const { createHash } = require('node:crypto');
const db = require('../../models');
const { getActiveSessionUser, getSessionUserId } = require('../session');
const { getConfiguredDropbox, normalizePathPart } = require('../../utils/documentStorage');
const { id, objectId, requestId, fields, text, member, hash } = require('../../utils/messagePolicy');

const MAX_FILE_SIZE = 25 * 1024 * 1024;
const CHUNK_SIZE = 256 * 1024;
const TYPES = { 'image/jpeg': 'Image', 'image/png': 'Image', 'image/webp': 'Image', 'image/gif': 'Image',
    'application/pdf': 'Document', 'text/plain': 'Document', 'text/csv': 'Document',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'Document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'Document' };
const EXTENSIONS = { 'image/jpeg': ['jpg', 'jpeg'], 'image/png': ['png'], 'image/webp': ['webp'], 'image/gif': ['gif'],
    'application/pdf': ['pdf'], 'text/plain': ['txt'], 'text/csv': ['csv'],
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['docx'],
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['xlsx'] };
const project = file => ({ _id: id(file), filename: file.filename, mime: file.mime, size: file.size, type: file.type, offset: file.offset, status: file.status, chunkSize: CHUNK_SIZE });

module.exports = (socket, io) => {
    const respond = (name, action) => socket.on(name, async (input, callback) => {
        const generation = socket.data.sessionGeneration;
        try {
            const user = await getActiveSessionUser(socket);
            const assertSession = () => {
                if (getSessionUserId(socket) !== id(user) || socket.data.sessionGeneration !== generation || socket.data.expiresAt <= Date.now()) throw new Error('Session changed');
            };
            const payload = await action(input || {}, user, assertSession);
            assertSession();
            callback?.({ status: 'success', payload });
        } catch (error) { callback?.({ status: 'error', message: error.message }); }
    });
    const topicAccess = async (topicId, user) => {
        const topic = await db.topic.findById(objectId(topicId)).lean();
        if (!member(topic, user._id)) throw new Error('Topic access denied');
        return topic;
    };
    const ownedFile = async (fileId, user, includeRemoved = false) => {
        const file = await db.messageAttachment.findOne({ _id: objectId(fileId), ownerId: user._id, ...(!includeRemoved ? { status: { $ne: 'Removed' } } : {}) }).lean();
        if (!file) throw new Error('Attachment unavailable');
        await topicAccess(id(file.topicId), user);
        return file;
    };
    const storage = () => {
        const dropbox = await getConfiguredDropbox();
        if (!dropbox) throw new Error('Message file storage is not configured');
        return dropbox;
    };

    respond('messageAttachment:stage', async (input, user, assertSession) => {
        fields(input, ['topicId', 'clientRequestId', 'filename', 'mime', 'size']);
        await topicAccess(input.topicId, user);
        const filename = text(input.filename, 200);
        if (!TYPES[input.mime] || !EXTENSIONS[input.mime].includes(filename.split('.').pop().toLowerCase()) || !Number.isSafeInteger(input.size) || input.size < 1 || input.size > MAX_FILE_SIZE) throw new Error('Choose a supported image or document up to 25 MB');
        const clientRequestId = requestId(input.clientRequestId);
        const requestHash = hash({ topicId: input.topicId, filename, mime: input.mime, size: input.size });
        storage();
        assertSession();
        const key = { ownerId: user._id, clientRequestId };
        let file;
        try {
            file = await db.messageAttachment.findOneAndUpdate(key, { $setOnInsert: {
                ...key, topicId: input.topicId, requestHash, filename, mime: input.mime, type: TYPES[input.mime], size: input.size,
                expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
            } }, { upsert: true, new: true, runValidators: true }).lean();
        } catch (error) {
            if (error.code !== 11000) throw error;
            file = await db.messageAttachment.findOne(key).lean();
        }
        if (!file || file.requestHash !== requestHash || file.status === 'Removed') throw new Error('Upload request changed. Select the file again.');
        if (file.status !== 'Attached') await db.messageAttachment.updateOne({ _id: file._id, status: { $in: ['Staged', 'Ready'] } }, { $set: { expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) } });
        return project(file);
    });
    respond('messageAttachment:chunk', async (input, user, assertSession) => {
        fields(input, ['_id', 'offset', 'contents']);
        let file = await ownedFile(input._id, user);
        if (['Ready', 'Attached'].includes(file.status)) return project(file);
        if ((!Buffer.isBuffer(input.contents) && !ArrayBuffer.isView(input.contents) && !(input.contents instanceof ArrayBuffer)) || !input.contents.byteLength || input.contents.byteLength > CHUNK_SIZE) throw new Error('Invalid upload bytes');
        const contents = Buffer.isBuffer(input.contents) ? input.contents : Buffer.from(input.contents instanceof ArrayBuffer ? input.contents : new Uint8Array(input.contents.buffer, input.contents.byteOffset, input.contents.byteLength));
        if (!Number.isSafeInteger(input.offset) || input.offset < 0 || !contents.length || contents.length > CHUNK_SIZE || input.offset + contents.length > file.size) throw new Error('Invalid upload chunk');
        const digest = createHash('sha256').update(contents).digest('hex');
        if (input.offset < file.offset) {
            if (input.offset === file.pendingOffset && digest === file.pendingHash) return project(file);
            throw new Error('Upload position changed. Retry the upload.');
        }
        if (input.offset !== file.offset || (file.pendingOffset === input.offset && file.pendingHash && file.pendingHash !== digest)) throw new Error('Upload chunk changed');
        const dropbox = storage();
        const folder = `/DH MES/message/${id(file.topicId)}`;
        const storagePath = `${folder}/${id(file)}-${normalizePathPart(file.filename)}`;
        if (!file.uploadSessionId) {
            for (const path of ['/DH MES', '/DH MES/message', folder]) {
                try { await dropbox.filesCreateFolderV2({ path, autorename: false }); }
                catch (error) { if (!String(error?.error?.error_summary || '').startsWith('path/conflict/folder')) throw error; }
            }
            const start = await dropbox.filesUploadSessionStart({ contents: Buffer.alloc(0), close: false });
            assertSession();
            await db.messageAttachment.updateOne({ _id: file._id, uploadSessionId: { $exists: false }, status: 'Staged' }, { $set: { uploadSessionId: start.result.session_id, storagePath } });
            file = await ownedFile(input._id, user);
        }
        assertSession();
        const pending = await db.messageAttachment.findOneAndUpdate({ _id: file._id, offset: input.offset, status: 'Staged',
            $or: [{ pendingOffset: { $ne: input.offset } }, { pendingHash: digest }] },
        { $set: { pendingOffset: input.offset, pendingSize: contents.length, pendingHash: digest } }, { new: true }).lean();
        if (!pending) throw new Error('Upload changed. Retry this chunk.');
        let alreadyFinished = false;
        try {
            await dropbox.filesUploadSessionAppendV2({ cursor: { session_id: file.uploadSessionId, offset: input.offset }, contents, close: false });
        } catch (error) {
            const detail = error?.error?.error;
            const correctOffset = detail?.correct_offset ?? detail?.incorrect_offset?.correct_offset;
            if (correctOffset !== input.offset + contents.length) {
                const metadata = input.offset + contents.length === file.size
                    ? await dropbox.filesGetMetadata({ path: storagePath }).catch(() => null) : null;
                if (metadata?.result?.size !== file.size) throw error;
                alreadyFinished = true;
            }
        }
        assertSession();
        const nextOffset = input.offset + contents.length;
        if (nextOffset === file.size && !alreadyFinished) {
            try {
                await dropbox.filesUploadSessionFinish({ cursor: { session_id: file.uploadSessionId, offset: nextOffset }, contents: Buffer.alloc(0),
                    commit: { path: storagePath, mode: 'overwrite', autorename: false, mute: true } });
            } catch (error) {
                const metadata = await dropbox.filesGetMetadata({ path: storagePath }).catch(() => null);
                if (metadata?.result?.size !== file.size) throw error;
            }
        }
        await topicAccess(id(file.topicId), user);
        assertSession();
        const saved = await db.messageAttachment.findOneAndUpdate({ _id: file._id, status: 'Staged', offset: input.offset }, {
            $set: { offset: nextOffset, ...(nextOffset === file.size ? { status: 'Ready' } : {}) },
        }, { new: true }).lean();
        return project(saved || await ownedFile(input._id, user));
    });
    respond('messageAttachment:remove', async (input, user, assertSession) => {
        fields(input, ['_id']);
        const file = await ownedFile(input._id, user, true);
        if (file.status === 'Attached' || file.messageRequestId) throw new Error('Attachment belongs to a message');
        assertSession();
        const removed = file.status === 'Removed' ? file : await db.messageAttachment.findOneAndUpdate({ _id: file._id, status: { $in: ['Staged', 'Ready'] }, messageRequestId: { $exists: false } }, { $set: { status: 'Removed' } }, { new: true }).lean();
        if (!removed) throw new Error('Attachment changed');
        if (file.storagePath) await storage().filesDeleteV2({ path: file.storagePath }).catch(error => {
            if (!String(error?.error?.error_summary || '').startsWith('path_lookup/not_found')) throw error;
        });
        return { _id: id(file) };
    });
    respond('messageAttachment:open', async (input, user, assertSession) => {
        fields(input, ['_id']);
        const file = await db.messageAttachment.findById(objectId(input._id)).lean();
        if (!file || file.status !== 'Attached' || !file.messageId) throw new Error('Attachment unavailable');
        await topicAccess(id(file.topicId), user);
        const message = await db.message.findOne({ _id: file.messageId, status: { $nin: ['Retracted', 'Deleted'] }, 'attachments.attachmentId': file._id }).lean();
        if (!message) throw new Error('Attachment unavailable');
        assertSession();
        const result = await storage().filesGetTemporaryLink({ path: file.storagePath });
        await topicAccess(id(file.topicId), user);
        assertSession();
        return { url: result.result.link, filename: file.filename, mime: file.mime };
    });
};
