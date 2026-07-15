const path = require('path');
const express = require('express');

const router = express.Router();
const pageRoot = path.join(__dirname, '..', 'addon', 'labelMaker', 'finishProduct');

router.get('/assets/config.js', (_req, res) => {
    const config = {
        socketPath: '/socket',
        socketAppToken: process.env.SOCKET_APP_TOKEN || 'MASTERWU',
    };
    res.set('Cache-Control', 'no-store');
    res.type('application/javascript').send(`window.LABEL_MAKER_CONFIG = ${JSON.stringify(config)};`);
});

router.use('/assets', express.static(path.join(pageRoot, 'assets')));

router.get('/', (_req, res) => {
    res.set({
        'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
        Pragma: 'no-cache',
        Expires: '0',
    });
    res.sendFile(path.join(pageRoot, 'index.html'));
});

module.exports = router;
