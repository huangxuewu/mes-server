const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const Y = require("yjs");
const { Hocuspocus } = require("@hocuspocus/server");
const { WebSocketServer } = require("ws");
const db = require("../models");
const { JWT_SECRET, hasPermission } = require("./session");
const { sessionSignature, isBoundDocumentSession, onSessionEnded, onPermissionsChanged } = require('./session');
const { acquireDocument, assertAccess } = require('../utils/documentAccess');

const COLLABORATION_PATH = "/collaboration";

const canUseDocumentCenter = (user) => user?.role === "System"
    || hasPermission(user, "module", "document")
    || hasPermission(user, "view", "document.article.view")
    || hasPermission(user, "update", "document.article.update");

const collaboration = new Hocuspocus({
    name: "mes-document-center",
    debounce: 1200,
    maxDebounce: 5000,
    async onAuthenticate({ token, documentName, connectionConfig }) {
        if (!token) throw new Error("Authentication required");
        const previous = collaboration.documents.get(documentName);
        if (previous?.fileSettingsPending) throw new Error('File settings are being applied. Reopen the document.');
        if (previous?.fileSettingsFrozen) {
            await collaboration.unloadDocument(previous);
            if (collaboration.documents.get(documentName) === previous) throw new Error('File settings are being applied. Reopen the document.');
        }
        const credentials = token.startsWith('{') ? JSON.parse(token) : { sessionToken: token };
        const decoded = jwt.verify(credentials.sessionToken, JWT_SECRET);
        const userId = decoded.userId || decoded._id || decoded.id;
        if (!isBoundDocumentSession(credentials.socketId, userId)) throw new Error('Sign in to open this document');
        if (!mongoose.isValidObjectId(userId) || !mongoose.isValidObjectId(documentName))
            throw new Error("Invalid collaboration session");

        const [user, document] = await Promise.all([
            db.user.findById(userId).lean(),
            db.document.findOne({ _id: documentName, isTemplate: false, status: { $ne: "Archived" } }).lean(),
        ]);
        if (!user || !document || !canUseDocumentCenter(user))
            throw new Error("Document access denied");
        assertAccess(user, document, credentials.documentToken);
        connectionConfig.readOnly = Boolean(document.locked || !(user.role === 'System' || hasPermission(user, 'module', 'document') || hasPermission(user, 'update', 'document.article.update')));

        return {
            userId: String(user._id),
            displayName: user.displayName || user.username || "User",
            sessionToken: credentials.sessionToken,
            documentToken: credentials.documentToken,
            signature: sessionSignature(user),
            version: document.securityVersion || 0,
            socketId: credentials.socketId,
        };
    },
    async beforeHandleMessage({ context, documentName, connection, document }) {
        const release = await acquireDocument(documentName);
        try {
            jwt.verify(context.sessionToken, JWT_SECRET);
            if (!isBoundDocumentSession(context.socketId, context.userId)) throw new Error('Session ended');
            const [user, record] = await Promise.all([db.user.findById(context.userId).lean(), db.document.findById(documentName).lean()]);
            assertAccess(user, record, context.documentToken);
            if (context.signature !== sessionSignature(user) || context.version !== (record.securityVersion || 0) || document.fileSettingsFrozen)
                throw new Error('Document access changed');
            connection.readOnly = Boolean(record.locked || !(user.role === 'System' || hasPermission(user, 'module', 'document') || hasPermission(user, 'update', 'document.article.update')));
            connection.documentRelease = release;
        } catch (error) { release(); throw error; }
    },
    async afterHandleMessage({ connection }) {
        connection.documentRelease?.(); connection.documentRelease = null;
    },
    async beforeUnloadDocument({ document }) {
        if (document.fileSettingsPending) throw new Error('File settings have not been saved yet');
    },
    async onLoadDocument({ documentName, document }) {
        const record = await db.document.findById(documentName).select("+yjsState");
        document.securityVersion = record?.securityVersion || 0;
        if (record?.yjsState?.length)
            Y.applyUpdate(document, new Uint8Array(record.yjsState));
    },
    async onStoreDocument({ documentName, document, lastContext }) {
        if (document.fileSettingsFrozen) return;
        const release = await acquireDocument(documentName);
        try {
        if (document.fileSettingsFrozen) return;
        const state = Buffer.from(Y.encodeStateAsUpdate(document));
        await db.document.updateOne(
            { _id: documentName, isTemplate: false, locked: { $ne: true }, status: { $ne: 'Archived' },
                securityVersion: document.securityVersion ? document.securityVersion : { $in: [null, 0] } },
            {
                $set: {
                    yjsState: state,
                    updatedBy: lastContext?.userId || undefined,
                },
            },
        );
        } finally { release(); }
    },
});
const closeSocketDocuments = socketId => {
    for (const document of collaboration.documents.values()) for (const connection of document.connections.keys())
        if (connection.context?.socketId === socketId) connection.close();
};
onSessionEnded?.(closeSocketDocuments);
onPermissionsChanged?.(closeSocketDocuments);

// Called while the settings handler holds the same per-document queue as messages.
const freezeDocument = async documentName => {
    const document = collaboration.documents.get(documentName);
    if (!document) return null;
    const fragment = document.getXmlFragment('default');
    const nodes = element => Array.from(element.toArray()).flatMap(child => {
        if (child instanceof Y.XmlText) return child.toDelta().filter(part => typeof part.insert === 'string' && part.insert)
            .map(part => ({ type: 'text', text: part.insert, ...(part.attributes ? { marks: Object.entries(part.attributes).map(([type, attrs]) => ({ type, ...(attrs && typeof attrs === 'object' ? { attrs } : {}) })) } : {}) }));
        return [{ type: child.nodeName, attrs: child.getAttributes(), content: nodes(child) }];
    });
    const contentJson = { type: 'doc', content: nodes(fragment) };
    const text = node => node.text || (node.content || []).map(text).join(' ');
    const snapshot = { yjsState: Buffer.from(Y.encodeStateAsUpdate(document)), ...(fragment.length ? { contentJson, plainText: text(contentJson).replace(/\s+/g, ' ').trim() } : {}) };
    // The caller holds the document queue: messages and stores wait until persistence finishes.
    // Keep connections and queued stores intact on failure, including a last-client disconnect.
    document.fileSettingsPending = true;
    return {
        snapshot,
        rollback() { document.fileSettingsPending = false; },
        async commit() {
            document.fileSettingsFrozen = true;
            document.fileSettingsPending = false;
            collaboration.closeConnections(documentName);
            collaboration.flushPendingStores();
            await collaboration.unloadDocument(document);
        },
    };
};

const attachCollaboration = (httpServer) => {
    const webSocketServer = new WebSocketServer({
        noServer: true,
        clientTracking: false,
        maxPayload: 5 * 1024 * 1024,
    });

    httpServer.on("upgrade", (request, socket, head) => {
        const pathname = new URL(request.url, "http://localhost").pathname;
        if (pathname !== COLLABORATION_PATH) return;

        webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
            const collaborationRequest = new Request(new URL(request.url, "http://localhost"), { headers: request.headers });
            const connection = collaboration.handleConnection(webSocket, collaborationRequest);
            webSocket.on("message", (data) => connection.handleMessage(new Uint8Array(data)));
            webSocket.on("close", (code, reason) => connection.handleClose({ code, reason: reason.toString() }));
            webSocket.on("error", (error) => {
                console.error("[Document collaboration] WebSocket error:", error.message);
                webSocket.terminate();
            });
        });
    });

    return collaboration;
};

module.exports = {
    COLLABORATION_PATH,
    attachCollaboration,
    collaboration,
    freezeDocument,
};
