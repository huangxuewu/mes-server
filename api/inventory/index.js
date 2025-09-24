const express = require('express');
const router = express.Router();
const db = require("../../models");

// Import sub-routes
const inboundRoutes = require('./inbound');
const outboundRoutes = require('./outbound');

// Mount sub-routes
router.use('/inbound', inboundRoutes);
router.use('/outbound', outboundRoutes);

// Helper function to get the correct model based on type
function getModelByType(type) {
    const models = {
        'finishedGoods': db.finishedGoods,
        'rawMaterials': db.rawMaterials,
        'tools': db.tools,
        'accessories': db.accessories
    };
    return models[type];
}

// Get all inventory items across all collections
router.get('/', async (req, res) => {
    try {
        const { type, category, subcategory, status } = req.query;
        
        if (type) {
            // Get items from specific collection
            const Model = getModelByType(type);
            if (!Model) {
                return res.status(400).json({ error: 'Invalid inventory type' });
            }
            
            const query = {};
            if (category) query.category = category;
            if (subcategory) query.subcategory = subcategory;
            if (status) query.status = status;
            
            const items = await Model.find(query).sort({ createdAt: -1 });
            res.json({ 
                type, 
                count: items.length, 
                items 
            });
        } else {
            // Get items from all collections
            const [finishedGoods, rawMaterials, tools, accessories] = await Promise.all([
                db.finishedGoods.find({}).sort({ createdAt: -1 }),
                db.rawMaterials.find({}).sort({ createdAt: -1 }),
                db.tools.find({}).sort({ createdAt: -1 }),
                db.accessories.find({}).sort({ createdAt: -1 })
            ]);
            
            res.json({
                finishedGoods: { count: finishedGoods.length, items: finishedGoods },
                rawMaterials: { count: rawMaterials.length, items: rawMaterials },
                tools: { count: tools.length, items: tools },
                accessories: { count: accessories.length, items: accessories }
            });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get inventory item by type and ID
router.get('/:type/:id', async (req, res) => {
    try {
        const { type, id } = req.params;
        const Model = getModelByType(type);
        
        if (!Model) {
            return res.status(400).json({ error: 'Invalid inventory type' });
        }
        
        const item = await Model.findById(id);
        if (!item) {
            return res.status(404).json({ error: 'Item not found' });
        }
        
        res.json(item);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Create new inventory item
router.post('/:type', async (req, res) => {
    try {
        const { type } = req.params;
        const Model = getModelByType(type);
        
        if (!Model) {
            return res.status(400).json({ error: 'Invalid inventory type' });
        }
        
        const item = new Model(req.body);
        await item.save();
        
        res.status(201).json(item);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Update inventory item
router.put('/:type/:id', async (req, res) => {
    try {
        const { type, id } = req.params;
        const Model = getModelByType(type);
        
        if (!Model) {
            return res.status(400).json({ error: 'Invalid inventory type' });
        }
        
        const item = await Model.findByIdAndUpdate(id, req.body, { new: true });
        if (!item) {
            return res.status(404).json({ error: 'Item not found' });
        }
        
        res.json(item);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Delete inventory item
router.delete('/:type/:id', async (req, res) => {
    try {
        const { type, id } = req.params;
        const Model = getModelByType(type);
        
        if (!Model) {
            return res.status(400).json({ error: 'Invalid inventory type' });
        }
        
        const item = await Model.findByIdAndDelete(id);
        if (!item) {
            return res.status(404).json({ error: 'Item not found' });
        }
        
        res.json({ message: 'Item deleted successfully' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get low stock items across all collections
router.get('/low-stock/all', async (req, res) => {
    try {
        const [finishedGoods, rawMaterials, tools, accessories] = await Promise.all([
            db.finishedGoods.findLowStock(),
            db.rawMaterials.findLowStock(),
            db.tools.findLowStock(),
            db.accessories.findLowStock()
        ]);
        
        res.json({
            finishedGoods: { count: finishedGoods.length, items: finishedGoods },
            rawMaterials: { count: rawMaterials.length, items: rawMaterials },
            tools: { count: tools.length, items: tools },
            accessories: { count: accessories.length, items: accessories }
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Update stock for an item
router.post('/:type/:id/stock', async (req, res) => {
    try {
        const { type, id } = req.params;
        const { quantity, operation = 'add' } = req.body;
        const Model = getModelByType(type);
        
        if (!Model) {
            return res.status(400).json({ error: 'Invalid inventory type' });
        }
        
        const item = await Model.findById(id);
        if (!item) {
            return res.status(404).json({ error: 'Item not found' });
        }
        
        await item.updateStock(quantity, operation);
        
        res.json(item);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
