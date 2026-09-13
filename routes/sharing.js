const express = require('express');
const path = require('node:path');

module.exports = phone => {
    const router = express.Router();
    router.use((_req, res, next) => {
        res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
            'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self' wss:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'" });
        next();
    });
    router.post('/end', express.json({ limit: '1kb' }), (req, res) => { phone.leave(req.body); res.sendStatus(204); });
    router.use(express.static(path.join(__dirname, '../addon/sharing')));
    return router;
};
