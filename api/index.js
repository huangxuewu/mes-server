const express = require('express');
const router = express.Router();

// Import route modules
const ediRoutes = require('./edi');
const loginRoutes = require('./login');
const inventoryRoutes = require('./inventory');

// Mount route modules
router.use('/edi', ediRoutes);
router.use('/login', loginRoutes);
router.use('/inventory', inventoryRoutes);

// API health check
router.get('/health', (req, res) => {
    res.json({ status: 'OK', message: 'API is running' });
});

module.exports = router;
