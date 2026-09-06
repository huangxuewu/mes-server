const { Dropbox } = require("dropbox");

const normalizePathPart = (value) => String(value || "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100) || "file";

const getDropbox = () => {
    const clientId = process.env.DROPBOX_CLIENT_ID;
    const clientSecret = process.env.DROPBOX_CLIENT_SECRET;
    const refreshToken = process.env.DROPBOX_REFRESH_TOKEN;
    if (!clientId || !clientSecret || !refreshToken) return null;
    return new Dropbox({ clientId, clientSecret, refreshToken, fetch });
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

const uploadDocumentFile = async ({ documentId, documentNumber, revision, fileName, contents, category = "attachments" }) => {
    const dropbox = getDropbox();
    if (!dropbox) return null;

    const safeName = normalizePathPart(fileName);
    const revisionFolder = revision ? `revision-${revision}` : "draft";
    const path = `/DH MES/document/${normalizePathPart(documentId)}/${revisionFolder}/${category}/${safeName}`;
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
    normalizePathPart,
    uploadDocumentFile,
};
