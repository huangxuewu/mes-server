const { randomBytes, scrypt, timingSafeEqual } = require('node:crypto');
const { promisify } = require('node:util');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const db = require('../../models');
const { getActiveSessionUser, JWT_SECRET } = require('../session');
const { acquireDocument, canManage, canView, idOf, safeDocument } = require('../../utils/documentAccess');
const deriveKey = promisify(scrypt);
const attempts = new Map();
const settingsOf = document => ({ locked: Boolean(document.locked), visibility: document.visibility || 'everyone',
    viewerIds: (document.viewerIds || []).map(idOf), hasPassword: Boolean(document.hasPassword),
    watermark: document.watermark || '', watermarkText: document.watermarkText || '', watermarkLayout: document.watermarkLayout || 'single',
    version: document.securityVersion || 0 });

module.exports = (socket, io) => {
    for (const event of ['documentSettings:get', 'documentSettings:update', 'documentAccess:unlock']) socket.on(event, async (input = {}, callback = () => {}) => {
        const generation = socket.data.sessionGeneration;
        const userId = idOf(socket.data.userId);
        const assertSession = () => {
            if (socket.data.sessionGeneration !== generation || idOf(socket.data.userId) !== userId || socket.data.expiresAt <= Date.now())
                throw new Error('Session changed. Sign in again.');
        };
        const activeUser = async () => {
            assertSession();
            const user = await getActiveSessionUser(socket);
            assertSession();
            return user;
        };
        let release, frozen, committed = false;
        try {
            let user = await activeUser();
            if (!mongoose.isValidObjectId(input.documentId)) throw new Error('A valid document id is required');
            release = await acquireDocument(input.documentId);
            const document = await db.document.findById(input.documentId).select('+passwordHash');
            user = await activeUser();
            if (!canView(user, document)) throw new Error('Document access denied');
            if (event === 'documentAccess:unlock') {
                const key = `${idOf(user)}:${idOf(document)}`;
                const recent = attempts.get(key);
                if (recent?.until > Date.now() && recent.count >= 5) throw new Error('Too many attempts. Try again in 15 minutes.');
                if (!recent || recent.until <= Date.now()) attempts.set(key, { count: 0, until: Date.now() + 15 * 60 * 1000 });
                for (const [id, entry] of attempts) if (entry.until <= Date.now()) attempts.delete(id);
                if (document.hasPassword && !canManage(user, document)) {
                    attempts.get(key).count++;
                    if (typeof input.password !== 'string' || input.password.length > 128) throw new Error('Incorrect password');
                    const [salt, encoded] = (document.passwordHash || '').split(':');
                    if (!salt || !encoded) throw new Error('Password protection is unavailable. Contact the owner.');
                    const actual = await deriveKey(input.password, salt, 64);
                    const expected = Buffer.from(encoded, 'hex');
                    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new Error('Incorrect password');
                }
                attempts.delete(key);
                user = await activeUser();
                if (!canView(user, document)) throw new Error('Document access denied');
                const token = jwt.sign({ userId: idOf(user), documentId: idOf(document), version: document.securityVersion || 0, socketId: socket.id, generation: socket.data.sessionGeneration }, JWT_SECRET,
                    { audience: 'document-access', expiresIn: Math.max(1, Math.min(3600, Math.floor((socket.data.expiresAt - Date.now()) / 1000))) });
                socket.data.documentGrants ||= {}; socket.data.documentGrants[idOf(document)] = token;
                return callback({ status: 'success', payload: { token } });
            }
            if (!canManage(user, document)) throw new Error('Only the document owner or an Admin can manage file settings');
            if (event === 'documentSettings:get') return callback({ status: 'success', payload: settingsOf(document) });
            if (document.isTemplate || document.status === 'Archived') throw new Error('File settings are unavailable for this document');
            if (input.expectedVersion !== (document.securityVersion || 0)) throw new Error('File settings changed. Close and reopen this panel.');
            const settings = input.settings || {};
            if (typeof settings.locked !== 'boolean' || !['everyone', 'selected'].includes(settings.visibility)
                || !['', 'manufacturer', 'confidential', 'custom'].includes(settings.watermark)
                || !['single', 'repeat'].includes(settings.watermarkLayout)) throw new Error('Invalid file settings');
            if (!Array.isArray(settings.viewerIds) || settings.viewerIds.length > 200 || settings.viewerIds.some(id => !mongoose.isValidObjectId(id))) throw new Error('Invalid viewer selection');
            const viewerIds = [...new Set(settings.viewerIds.map(String))];
            if (viewerIds.length && await db.user.countDocuments({ _id: { $in: viewerIds }, status: 'Active' }) !== viewerIds.length) throw new Error('Choose active MES users');
            const watermarkText = String(settings.watermarkText || '').trim().replace(/\s+/g, ' ').slice(0, 120);
            if (settings.watermark && !watermarkText) throw new Error('Enter watermark text');
            const patch = { locked: settings.locked, visibility: settings.visibility, viewerIds,
                watermark: settings.watermark, watermarkText: settings.watermark ? watermarkText : '', watermarkLayout: settings.watermarkLayout,
                updatedBy: user._id, securityVersion: (document.securityVersion || 0) + 1 };
            if (input.passwordChange?.action === 'set') {
                const password = input.passwordChange.value;
                if (typeof password !== 'string' || password.length < 8 || password.length > 128) throw new Error('Use a password between 8 and 128 characters');
                const salt = randomBytes(16).toString('hex');
                patch.passwordHash = `${salt}:${(await deriveKey(password, salt, 64)).toString('hex')}`;
                patch.hasPassword = true;
            } else if (input.passwordChange?.action === 'remove') {
                patch.passwordHash = ''; patch.hasPassword = false;
            } else if (input.passwordChange) throw new Error('Invalid password action');
            const { freezeDocument } = require('../collaboration');
            user = await activeUser();
            if (!canView(user, document) || !canManage(user, document)) throw new Error('Document access denied');
            frozen = await freezeDocument(idOf(document));
            if (frozen) Object.assign(patch, frozen.snapshot);
            assertSession();
            const saved = await db.document.findOneAndUpdate({ _id: document._id, securityVersion: document.securityVersion === undefined ? { $in: [null, 0] } : document.securityVersion }, { $set: patch }, { new: true, runValidators: true });
            if (!saved) throw new Error('File settings changed. Reopen the panel.');
            committed = true;
            await frozen?.commit();
            // Invalidate every open view before any subsequent document content is sent.
            for (const recipient of await io.fetchSockets()) if (recipient.data.documentSeen?.has(idOf(document)))
                recipient.emit('document:accessChanged', { documentId: idOf(document) });
            user = await activeUser();
            if (!canView(user, saved) || !canManage(user, saved)) throw new Error('Document access denied');
            const safe = await safeDocument(saved, user, socket);
            assertSession();
            callback({ status: 'success', payload: { settings: settingsOf(saved), document: safe } });
        } catch (error) { callback({ status: 'error', message: error.message }); }
        finally { if (!committed) frozen?.rollback(); release?.(); }
    });
};
