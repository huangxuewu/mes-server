const { Dropbox } = require("dropbox");

const normalizePathPart = (value) => String(value || "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100) || "file";

const getDropbox = ({ signal, config = {} } = {}) => {
    const clientId = String(config['integration.dropbox.clientId'] || '').trim() || process.env.DROPBOX_CLIENT_ID;
    const clientSecret = String(config['integration.dropbox.clientSecret'] || '').trim() || process.env.DROPBOX_CLIENT_SECRET;
    const refreshToken = String(config['integration.dropbox.refreshToken'] || '').trim() || process.env.DROPBOX_REFRESH_TOKEN;
    if (!clientId || !clientSecret || !refreshToken) return null;
    return new Dropbox({ clientId, clientSecret, refreshToken,
        fetch: signal ? (url, options) => fetch(url, { ...options, signal }) : fetch });
};

const getConfiguredDropbox = async ({ signal, db = require('../models') } = {}) => {
    const at = new Date();
    const records = await db.config.find({
        key: { $in: ['integration.dropbox.clientId', 'integration.dropbox.clientSecret', 'integration.dropbox.refreshToken'] },
        status: 'Active',
        'effective.from': { $lte: at },
        $or: [{ 'effective.to': null }, { 'effective.to': { $gte: at } }],
    }, { key: 1, value: 1 }).maxTimeMS(5000).lean();
    signal?.throwIfAborted();
    return getDropbox({ signal, config: Object.fromEntries(records.map(({ key, value }) => [key, value])) });
};

const sharedUrl = async (dropbox, path) => {
    try {
        const result = await dropbox.sharingCreateSharedLinkWithSettings({ path });
        return result.result.url.replace("?dl=0", "?raw=1");
    } catch (error) {
        if (error?.error?.error?.[".tag"] !== "shared_link_already_exists") throw error;
        const links = await dropbox.sharingListSharedLinks({ path, direct_only: true });
        return links.result.links[0]?.url?.replace("?dl=0", "?raw=1") || "";
    }
};

const uploadDocumentFile = async ({ documentId, documentNumber, revision, fileName, contents, category = "attachments", dropbox = getDropbox() }) => {
    if (!dropbox) return null;

    const safeName = normalizePathPart(fileName);
    const revisionFolder = revision ? `revision-${revision}` : "draft";
    const path = `/DocumentCenter/${normalizePathPart(documentId)}/${revisionFolder}/${category}/${safeName}`;
    await dropbox.filesUpload({
        path,
        contents,
        mode: { ".tag": "overwrite" },
        autorename: false,
        mute: true,
    });

    return {
        url: await sharedUrl(dropbox, path),
        storagePath: path,
    };
};

module.exports = {
    getDropbox,
    getConfiguredDropbox,
    normalizePathPart,
    uploadDocumentFile,
};
