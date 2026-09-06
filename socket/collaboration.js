const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const Y = require("yjs");
const { Hocuspocus } = require("@hocuspocus/server");
const { WebSocketServer } = require("ws");
const db = require("../models");
const { JWT_SECRET, hasPermission } = require("./session");

const COLLABORATION_PATH = "/collaboration";

const canUseDocumentCenter = (user) => user?.role === "System"
    || hasPermission(user, "module", "document")
    || hasPermission(user, "update", "document.article.update");

const collaboration = new Hocuspocus({
    name: "mes-document-center",
    debounce: 1200,
    maxDebounce: 5000,
    async onAuthenticate({ token, documentName }) {
        if (!token) throw new Error("Authentication required");

        const decoded = jwt.verify(token, JWT_SECRET);
        const userId = decoded.userId || decoded._id || decoded.id;
        if (!mongoose.isValidObjectId(userId) || !mongoose.isValidObjectId(documentName))
            throw new Error("Invalid collaboration session");

        const [user, document] = await Promise.all([
            db.user.findById(userId).lean(),
            db.document.findOne({ _id: documentName, isTemplate: false, status: { $ne: "Archived" } }).lean(),
        ]);
        if (!user || !document || !canUseDocumentCenter(user))
            throw new Error("Document access denied");

        return {
            userId: String(user._id),
            displayName: user.displayName || user.username || "User",
        };
    },
    async onLoadDocument({ documentName, document }) {
        const record = await db.document.findById(documentName).select("+yjsState");
        if (record?.yjsState?.length)
            Y.applyUpdate(document, new Uint8Array(record.yjsState));
    },
    async onStoreDocument({ documentName, document, lastContext }) {
        const state = Buffer.from(Y.encodeStateAsUpdate(document));
        await db.document.updateOne(
            { _id: documentName, isTemplate: false },
            {
                $set: {
                    yjsState: state,
                    updatedBy: lastContext?.userId || undefined,
                },
            },
        );
    },
});

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
            collaboration.handleConnection(webSocket, request);
        });
    });

    return collaboration;
};

module.exports = {
    COLLABORATION_PATH,
    attachCollaboration,
    collaboration,
};
