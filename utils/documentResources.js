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

const collectReferences = (value, references, candidates) => {
    if (typeof value === "string") {
        const key = resourceKey(value);
        if (candidates.has(key)) references.add(key);
    } else if (Array.isArray(value)) value.forEach((item) => collectReferences(item, references, candidates));
    else if (value && typeof value === "object") Object.values(value).forEach((item) => collectReferences(item, references, candidates));
};

const collectSharedReferences = (node, references, candidates) => {
    if (node.getAttributes) collectReferences(node.getAttributes(), references, candidates);
    if (node.toDelta) collectReferences(node.toDelta(), references, candidates);
    if (node.toArray) node.toArray().forEach((child) => collectSharedReferences(child, references, candidates));
};

const isResource = (asset) => !/\/original\//i.test(asset.storagePath || "")
    && (asset.purpose === "resource"
        || (!asset.purpose && (asset.mimeType?.startsWith("image/") || /\.(png|jpe?g|webp|gif|avif|svg|bmp)$/i.test(asset.name || ""))));

const cleanupDocumentResources = async ({ documentId, resourceIds, db, dropbox, liveDocuments = new Map() }) => {
    const checkedAt = new Date();
    const owner = await db.document.findById(documentId).select("attachments").lean();
    if (!owner) return;
    const assets = (owner.attachments || []).filter(asset => resourceIds.includes(String(asset._id)) && isResource(asset));
    if (!assets.length) return;
    // Keep only candidate file keys, not every text string in the document corpus.
    const candidates = new Set(assets.flatMap(asset => [resourceKey(asset.url), asset.storagePath]));
    const references = new Set();
    const documents = db.document.find({}).select("contentJson formSchema thumbnail attachments +yjsState").lean().cursor({ batchSize: 32 });
    try {
        for await (const document of documents) {
            collectReferences([document.contentJson, document.formSchema, document.thumbnail], references, candidates);
            collectReferences((document.attachments || []).filter((asset) => String(document._id) !== String(documentId) || !isResource(asset)), references, candidates);
            // The collaboration state can be newer than the last JSON autosave.
            const state = document.yjsState?._bsontype === 'Binary' ? document.yjsState.value() : document.yjsState;
            if (state?.length) {
                const shared = new Y.Doc();
                try {
                    Y.applyUpdate(shared, new Uint8Array(state));
                    collectSharedReferences(shared.getXmlFragment("default"), references, candidates);
                } finally {
                    shared.destroy();
                }
            }
        }
    } finally { await documents.close(); }
    const revisions = db.documentRevision.find({}).select("contentJson formSchema artifacts").lean().cursor({ batchSize: 32 });
    try {
        for await (const revision of revisions) collectReferences(revision, references, candidates);
    } finally { await revisions.close(); }
    const removedIds = [];
    try {
        for (const asset of assets) {
            for (const shared of liveDocuments.values()) collectSharedReferences(shared.getXmlFragment("default"), references, candidates);
            if (references.has(resourceKey(asset.url)) || references.has(asset.storagePath)) continue;
            // Only individual files owned by this document may be deleted.
            const prefixes = [`/DocumentCenter/${documentId}/`, `/DH MES/document/${documentId}/`, `/MES/DocumentCenter/${documentId}/`];
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
                for (const shared of liveDocuments.values()) collectSharedReferences(shared.getXmlFragment("default"), references, candidates);
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
