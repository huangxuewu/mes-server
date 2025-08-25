const express = require('express');
const router = express.Router();
const db = require("../../models");

// GET all production orders
router.get('/', (req, res) => {
    res.json({ message: 'Get all production orders' });
});

// GET single production order by ID
router.get('/:id', (req, res) => {
    res.json({ message: `Get production order ${req.params.id}` });
});

// POST create new production order
router.post('/', (req, res) => {
    res.json({ message: 'Create new production order', data: req.body });
});

// PUT update production order
router.put('/:id', (req, res) => {
    res.json({ message: `Update production order ${req.params.id}`, data: req.body });
});

// DELETE production order
router.delete('/:id', (req, res) => {
    res.json({ message: `Delete production order ${req.params.id}` });
});

// GET production status
router.get('/:id/status', (req, res) => {
    res.json({ message: `Get production status for order ${req.params.id}` });
});

module.exports = router;
