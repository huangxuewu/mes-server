const express = require('express');
const { createSignaturePadAccess } = require('../utils/signaturePadAccess');
const { JWT_SECRET, resolveUserPermissions } = require('../socket/session');

module.exports = (models = require('../models')) => {
    const router = express.Router();
    const access = createSignaturePadAccess({ models, secret: JWT_SECRET, getUser: async id => resolveUserPermissions(await models.user.findById(id).lean()) });
    router.use(async (req, res, next) => {
        res.set('Cache-Control', 'no-store');
        try { req.pad = await access.authenticate(req.get('Authorization')?.replace(/^Bearer /, '')); next(); }
        catch { res.status(401).json({ status: 'error', message: 'signaturePad.deviceUnauthorized' }); }
    });
    router.use(express.json({ limit: '300kb' }));
    for (const operation of ['lookup', 'sign']) router.post(`/bol/${operation}`, async (req, res) => {
        try {
            const payload = operation === 'lookup' ? await access.lookup(req.pad, req.body?.barcode) : await access.sign(req.pad, req.body);
            res.json({ status: 'success', payload });
        } catch (error) {
            const message = error.message?.startsWith('signaturePad.') ? error.message : 'signaturePad.serverUnavailable';
            res.status(400).json({ status: 'error', message });
        }
    });
    router.post('/revoke', async (req, res, next) => {
        try {
            await models.signaturePadDevice.updateOne({ _id: req.pad._id, tokenHash: req.pad.tokenHash }, { $set: { revoked: true } });
            res.json({ status: 'success' });
        } catch (error) { next(error); }
    });
    router.use((error, _req, res, _next) => res.status(400).json({ status: 'error', message: 'signaturePad.invalidMessage' }));
    return router;
};
