const Y = require("yjs");

const resourceKey = (value) => {
    if (typeof value !== "string") return "";
    try {
        const url = new URL(value);
        if (["www.dropbox.com", "dropbox.com", "dl.dropboxusercontent.com"].includes(url.hostname)) {
            const sharedId = url.pathname.match(/^\/(?:scl\/fi|s)\/([^/]+)/)?.[1];
            return sharedId ? `dropbox:${sharedId}` : `dropbox:${url.pathname}`;
        }
        return value;
    } catch {
        return value;
    }
};

const collectReferences = (value, references) => {
    if (typeof value === "string") references.add(resourceKey(value));
    else if (Array.isArray(value)) value.forEach((item) => collectReferences(item, references));
    else if (value && typeof value === "object") Object.values(value).forEach((item) => collectReferences(item, references));
};

const collectSharedReferences = (node, references) => {
    if (node.getAttributes) collectReferences(node.getAttributes(), references);
    if (node.toDelta) collectReferences(node.toDelta(), references);
    if (node.toArray) node.toArray().forEach((child) => collectSharedReferences(child, references));
};

const isResource = (asset) => !/\/original\//i.test(asset.storagePath || "")
    && (asset.purpose === "resource"
        || (!asset.purpose && (asset.mimeType?.startsWith("image/") || /\.(png|jpe?g|webp|gif|avif|svg|bmp)$/i.test(asset.name || ""))));

const cleanupDocumentResources = async ({ documentId, resourceIds, db, dropbox, liveDocuments = new Map() }) => {
    const checkedAt = new Date();
    const [documents, revisions] = await Promise.all([
        db.document.find({}).select("contentJson formSchema thumbnail attachments +yjsState").lean(),
        db.documentRevision.find({}).select("contentJson formSchema artifacts").lean(),
    ]);
    const owner = documents.find((document) => String(document._id) === String(documentId));
    if (!owner) return;
    const references = new Set();
    for (const document of documents) {
        collectReferences([document.contentJson, document.formSchema, document.thumbnail], references);
        collectReferences((document.attachments || []).filter((asset) => String(document._id) !== String(documentId) || !isResource(asset)), references);
        // The collaboration state can be newer than the last JSON autosave.
        if (document.yjsState?.length) {
            const shared = new Y.Doc();
            try {
                Y.applyUpdate(shared, new Uint8Array(document.yjsState));
                collectSharedReferences(shared.getXmlFragment("default"), references);
            } finally {
                shared.destroy();
            }
        }
    }
    collectReferences(revisions, references);
    const removedIds = [];
    try {
        for (const asset of owner.attachments || []) {
            if (!resourceIds.includes(String(asset._id))) continue;
            if (!isResource(asset)) continue;
            for (const shared of liveDocuments.values()) collectSharedReferences(shared.getXmlFragment("default"), references);
            if (references.has(resourceKey(asset.url)) || references.has(asset.storagePath)) continue;
            // Only individual files owned by this document may be deleted.
            const prefixes = [`/DH MES/document/${documentId}/`, `/MES/DocumentCenter/${documentId}/`];
            const prefix = prefixes.find((path) => asset.storagePath?.startsWith(path));
            const parts = prefix ? asset.storagePath.slice(prefix.length).split("/") : [];
            if (!parts.length || parts.some((part) => !part || part === "." || part === "..")) continue;
            try {
                const metadata = await dropbox.filesGetMetadata({ path: asset.storagePath });
                if (metadata.result?.[".tag"] !== "file") continue;
                const [changedDocument, changedRevision] = await Promise.all([
                    db.document.exists({ updatedAt: { $gte: checkedAt } }),
                    db.documentRevision.exists({ updatedAt: { $gte: checkedAt } }),
                ]);
                if (changedDocument || changedRevision) return;
                for (const shared of liveDocuments.values()) collectSharedReferences(shared.getXmlFragment("default"), references);
                if (references.has(resourceKey(asset.url)) || references.has(asset.storagePath)) continue;
                await dropbox.filesDeleteV2({ path: asset.storagePath });
            } catch (error) {
                const summary = error?.error?.error_summary || "";
                if (!summary.includes("path/not_found")) throw error;
            }
            removedIds.push(asset._id);
        }
    } finally {
        if (removedIds.length)
            await db.document.updateOne({ _id: documentId }, { $pull: { attachments: { _id: { $in: removedIds } } } });
    }
};

module.exports = { cleanupDocumentResources, resourceKey };
