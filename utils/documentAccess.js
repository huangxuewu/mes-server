const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { getActiveSessionUser, hasPermission, JWT_SECRET, isBoundDocumentSession } = require('../socket/session');
const idOf = value => String(value?._id || value || '');
const queues = new Map();

// Serialize settings changes with document mutations and collaborative messages.
const acquireDocument = async id => {
    id = idOf(id);
    const previous = queues.get(id) || Promise.resolve();
    let release;
    const next = new Promise(resolve => { release = resolve; });
    queues.set(id, next);
    await previous;
    return () => { release(); if (queues.get(id) === next) queues.delete(id); };
};
const canManage = (user, document) => ['Admin', 'System'].includes(user?.role)
    || [document?.owner, document?.createdBy].some(id => idOf(id) && idOf(id) === idOf(user));
const canView = (user, document) => Boolean(user && user.status === 'Active' && document
    && (user.role === 'System' || hasPermission(user, 'module', 'document') || hasPermission(user, 'view', 'document.article.view'))
    && (document.visibility !== 'selected' || canManage(user, document) || document.viewerIds?.some(id => idOf(id) === idOf(user))));
const hasGrant = (user, document, token) => {
    if (!document.hasPassword || canManage(user, document)) return true;
    try {
        const grant = jwt.verify(token, JWT_SECRET, { audience: 'document-access' });
        return grant.userId === idOf(user) && grant.documentId === idOf(document)
            && grant.version === (document.securityVersion || 0)
            && isBoundDocumentSession(grant.socketId, grant.userId, grant.generation);
    } catch { return false; }
};
const assertAccess = (user, document, token, write = false) => {
    if (!canView(user, document)) throw new Error('Document access denied');
    if (!hasGrant(user, document, token)) throw new Error('DOCUMENT_PASSWORD_REQUIRED');
    if (write && (document.locked || document.status === 'Archived')) throw new Error('Document is locked for editing');
};
const safeDocument = async (document, user, socket) => {
    const value = document.toObject ? document.toObject() : { ...document };
    delete value.passwordHash;
    delete value.pdfPassword;
    value.canManageSettings = canManage(user, value);
    value.canEdit = !value.locked && value.status !== 'Archived' && (user.role === 'System'
        || hasPermission(user, 'module', 'document') || hasPermission(user, 'update', 'document.article.update'));
    if (!value.canManageSettings) delete value.viewerIds;
    if (value.relatedDocuments?.length) {
        const db = require('../models');
        const linked = await db.document.find({ _id: { $in: value.relatedDocuments.map(link => idOf(link.document)) } }).lean();
        const visible = new Set(linked.filter(item => canView(user, item) && hasGrant(user, item, socket?.data?.documentGrants?.[idOf(item)])).map(idOf));
        value.relatedDocuments = value.relatedDocuments.filter(link => visible.has(idOf(link.document)));
    }
    return value;
};
const listDocument = async (document, user, socket) => {
    if (!canView(user, document)) return null;
    socket.data.documentSeen ||= new Set();
    socket.data.documentSeen.add(idOf(document));
    if (!hasGrant(user, document, socket.data.documentGrants?.[idOf(document)]))
        return Object.fromEntries(['_id', 'title', 'documentNumber', 'type', 'status', 'locked', 'hasPassword', 'currentRevision'].map(key => [key, document[key]]));
    return safeDocument(document, user, socket);
};

const documentIdFor = async (event, input) => {
    const db = require('../models');
    if (['documentComment:reply', 'documentComment:resolve'].includes(event))
        return (await db.documentComment.findById(input._id).select('document').lean())?.document;
    if (event === 'formSubmission:update')
        return (await db.formSubmission.findById(input._id).select('document').lean())?.document;
    if (event === 'document:create') return input.templateId;
    if (['document:get', 'document:update', 'document:publish', 'document:archive', 'document:exportDocx'].includes(event)) return input._id;
    if (event.startsWith('document') || event.startsWith('form')) return input.documentId;
};
const protectDocumentSocket = socket => ({
    on(event, handler) {
        socket.on(event, async (...args) => {
            const callback = typeof args.at(-1) === 'function' ? args.at(-1) : () => {};
            let release;
            try {
                const user = await getActiveSessionUser(socket);
                const input = args[0] || {};
                const id = await documentIdFor(event, input);
                if (id) {
                    if (!mongoose.isValidObjectId(id)) throw new Error('A valid document id is required');
                    release = await acquireDocument(id);
                    const document = await require('../models').document.findById(id).lean();
                    const write = ['document:update', 'documentAsset:upload', 'documentResources:cleanup'].includes(event);
                    assertAccess(user, document, socket.data.documentGrants?.[idOf(id)], write);
                    const original = callback;
                    args[args.length - 1] = async response => {
                        try {
                            if (response.status === 'success') {
                                const current = await require('../models').document.findById(id).lean();
                                assertAccess(await getActiveSessionUser(socket), current, socket.data.documentGrants?.[idOf(id)]);
                                if (response.payload?._id && ['document:get', 'document:update', 'document:publish', 'documentAsset:upload', 'documentResources:cleanup'].includes(event))
                                    response.payload = await safeDocument(response.payload, user, socket);
                                if (event === 'documentRevisions:get') response.payload = await Promise.all(response.payload.map(item => safeDocument(item, user, socket)));
                                if (response.payload?.document?._id) response.payload.document = await safeDocument(response.payload.document, user, socket);
                                socket.data.documentSeen ||= new Set(); socket.data.documentSeen.add(idOf(id));
                            }
                            original(response);
                        } catch (error) { original({ status: 'error', message: error.message }); }
                    };
                }
                await handler(...args);
            } catch (error) { callback({ status: 'error', message: error.message }); }
            finally { release?.(); }
        });
    },
    get data() { return socket.data; },
});

const protectedDocumentEmitter = io => ({
    async emit(event, payload) {
        try {
            const db = require('../models');
            const isReference = event.startsWith('auditReference:');
            const id = event.startsWith('documentComment:') || event.startsWith('formSubmission:') ? payload.document : payload?._id || payload;
            const document = isReference ? null : await db.document.findById(idOf(id)).lean();
            for (const socket of await io.fetchSockets()) {
                try {
                    const user = await getActiveSessionUser(socket);
                    if (isReference) {
                        if (hasPermission(user, 'module', 'document') || hasPermission(user, 'view', 'document.article.view')) socket.emit(event, payload);
                        continue;
                    }
                    if (!canView(user, document) || !hasGrant(user, document, socket.data.documentGrants?.[idOf(document)])) {
                        if (socket.data.documentSeen?.has(idOf(id))) socket.emit('document:accessChanged', { documentId: idOf(id) });
                        continue;
                    }
                    const safe = ['document:created', 'document:updated', 'documentTemplate:created'].includes(event)
                        ? await safeDocument(payload, user, socket) : payload;
                    socket.data.documentSeen ||= new Set(); socket.data.documentSeen.add(idOf(id));
                    socket.emit(event, safe);
                } catch { /* An invalid recipient never receives document data. */ }
            }
        } catch (error) { console.error('Document notification failed:', error.message); }
    },
});
module.exports = { acquireDocument, canManage, canView, hasGrant, assertAccess, safeDocument, listDocument, protectDocumentSocket, protectedDocumentEmitter, idOf };
