const express = require('express');
const router = express.Router();
const db = require("../../models");

// GET all inbound items
router.get('/', (req, res) => {
    res.json({ message: 'Get all inbound inventory items' });
});

// GET single inbound item by ID
router.get('/:id', (req, res) => {
    res.json({ message: `Get inbound inventory item ${req.params.id}` });
});

// POST create new inbound item
router.post('/', (req, res) => {
    res.json({ message: 'Create new inbound inventory item', data: req.body });
});

// PUT update inbound item
router.put('/:id', (req, res) => {
    res.json({ message: `Update inbound inventory item ${req.params.id}`, data: req.body });
});

// DELETE inbound item
router.delete('/:id', (req, res) => {
    res.json({ message: `Delete inbound inventory item ${req.params.id}` });
});

// POST receive inbound item
router.post('/:id/receive', (req, res) => {
    res.json({ message: `Receive inbound inventory item ${req.params.id}`, data: req.body });
});

// GET inbound status
router.get('/:id/status', (req, res) => {
    res.json({ message: `Get inbound status for item ${req.params.id}` });
});

module.exports = router;
