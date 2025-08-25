const express = require('express');
const router = express.Router();
const db = require("../../models");

// Import sub-routes
const inboundRoutes = require('./inbound');
const outboundRoutes = require('./outbound');

// Mount sub-routes
router.use('/inbound', inboundRoutes);
router.use('/outbound', outboundRoutes);

// General inventory endpoints
router.get('/', (req, res) => {
    res.json({ message: 'Get all inventory items' });
});

router.get('/:id', (req, res) => {
    res.json({ message: `Get inventory item ${req.params.id}` });
});

router.post('/', (req, res) => {
    res.json({ message: 'Create new inventory item', data: req.body });
});

router.put('/:id', (req, res) => {
    res.json({ message: `Update inventory item ${req.params.id}`, data: req.body });
});

router.delete('/:id', (req, res) => {
    res.json({ message: `Delete inventory item ${req.params.id}` });
});

module.exports = router;
