const express = require('express');
const { createSignaturePadAccess } = require('../utils/signaturePadAccess');
const { createSignaturePadWorkflow } = require('../utils/signaturePadWorkflow');
const { JWT_SECRET, resolveUserPermissions } = require('../socket/session');

module.exports = (models = require('../models')) => {
    const router = express.Router();
    const access = createSignaturePadAccess({ models, secret: JWT_SECRET, getUser: async id => resolveUserPermissions(await models.user.findById(id).lean()) });
    const workflow = createSignaturePadWorkflow({ models, secret: JWT_SECRET });
    router.use(async (req, res, next) => {
        res.set('Cache-Control', 'no-store');
        try { req.pad = await access.authenticate(req.get('Authorization')?.replace(/^Bearer /, '')); next(); }
        catch { res.status(401).json({ status: 'error', message: 'signaturePad.deviceUnauthorized' }); }
    });
    router.use(express.json({ limit: '600kb' }));
    for (const operation of ['lookup', 'prepare', 'sign']) router.post(`/bol/${operation}`, async (req, res) => {
        try {
            const payload = operation === 'lookup' ? await access.lookup(req.pad, req.body?.barcode, req.body?.allowSigned === true, req.body?.allowCreate === true) : await access[operation](req.pad, req.body);
            res.json({ status: 'success', payload });
        } catch (error) {
            const message = error.message?.startsWith('signaturePad.') ? error.message : 'signaturePad.serverUnavailable';
            res.status(400).json({ status: 'error', message });
        }
    });
    for (const operation of ['lookup', 'confirm']) router.post(`/workflow/${operation}`, async (req, res) => {
        try {
            const payload = await workflow[operation](req.pad, operation === 'lookup' ? req.body?.barcode : req.body);
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
