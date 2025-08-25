const express = require('express');
const router = express.Router();
const db = require("../../models");

// GET all outbound items
router.get('/', (req, res) => {
    res.json({ message: 'Get all outbound inventory items' });
});

// Get all outbound loads
router.get('/loads', async (req, res) => {
    console.log("Get all outbound loads");
    
    const loads = await db.shipment.getActiveLoads();

    res.json(loads);
});

// GET single outbound item by ID
router.get('/:id', (req, res) => {
    res.json({ message: `Get outbound inventory item ${req.params.id}` });
});

// POST create new outbound item
router.post('/', (req, res) => {
    res.json({ message: 'Create new outbound inventory item', data: req.body });
});

// PUT update outbound item
router.put('/:id', (req, res) => {
    res.json({ message: `Update outbound inventory item ${req.params.id}`, data: req.body });
});

// DELETE outbound item
router.delete('/:id', (req, res) => {
    res.json({ message: `Delete outbound inventory item ${req.params.id}` });
});

// POST ship outbound item
router.post('/:id/ship', (req, res) => {
    res.json({ message: `Ship outbound inventory item ${req.params.id}`, data: req.body });
});

// GET outbound status
router.get('/:id/status', (req, res) => {
    res.json({ message: `Get outbound status for item ${req.params.id}` });
});

// POST pick outbound item
router.post('/:id/pick', (req, res) => {
    res.json({ message: `Pick outbound inventory item ${req.params.id}`, data: req.body });
});

module.exports = router;
