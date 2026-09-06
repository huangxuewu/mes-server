const cleanupMessageAttachments = async ({ db, dropbox, now = new Date() }) => {
    if (!dropbox) return { removed: 0, skipped: 0 };
    const files = await db.messageAttachment.find({ expiresAt: { $lte: now }, status: { $in: ['Staged', 'Ready', 'Removed'] } }).limit(50).lean();
    let removed = 0, skipped = 0;
    for (const file of files) {
        const message = await db.message.findOne({ 'attachments.attachmentId': file._id }).lean();
        if (message) {
            await db.messageAttachment.updateOne({ _id: file._id }, { $set: { status: 'Attached', messageId: message._id, messageRequestId: message.clientRequestId }, $unset: { expiresAt: '' } });
            skipped++;
            continue;
        }
        const claimed = await db.messageAttachment.findOneAndUpdate({ _id: file._id, expiresAt: file.expiresAt, status: { $in: ['Staged', 'Ready', 'Removed'] } }, { $set: { status: 'Removed' } }, { new: true }).lean();
        if (!claimed) { skipped++; continue; }
        try {
            if (file.storagePath) await dropbox.filesDeleteV2({ path: file.storagePath });
        } catch (error) {
            if (!String(error?.error?.error_summary || '').includes('not_found')) { skipped++; continue; }
        }
        await db.messageAttachment.deleteOne({ _id: file._id, status: 'Removed' });
        removed++;
    }
    return { removed, skipped };
};
const startMessageAttachmentCleanup = () => {
    let pending = false;
    const run = async () => {
        if (pending) return;
        pending = true;
        try {
            await cleanupMessageAttachments({ db: require('../models'), dropbox: require('./documentStorage').getDropbox() });
        } catch (error) { console.error('Message attachment cleanup failed:', error.message); }
        finally { pending = false; }
    };
    const timer = setInterval(run, 10 * 60 * 1000);
    timer.unref?.();
    return () => clearInterval(timer);
};
module.exports = { cleanupMessageAttachments, startMessageAttachmentCleanup };
