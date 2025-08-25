const express = require('express');
const router = express.Router();

// Import route modules
const loginRoutes = require('./login');
const inventoryRoutes = require('./inventory');
const productionRoutes = require('./production');

// Mount route modules
router.use('/login', loginRoutes);
router.use('/inventory', inventoryRoutes);
router.use('/production', productionRoutes);

// API health check
router.get('/health', (req, res) => {
    res.json({ status: 'OK', message: 'API is running' });
});

module.exports = router;
