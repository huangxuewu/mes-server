const db = require("../../models");

module.exports = (socket, io) => {

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

    // Get inventory items by type
    socket.on("inventory:list", async (data, callback) => {
        try {
            const { type, query = {} } = data;
            
            if (type) {
                const Model = getModelByType(type);
                if (!Model) {
                    return callback({ status: "error", message: "Invalid inventory type" });
                }
                
                const items = await Model.find(query).sort({ createdAt: -1 });
                callback({ 
                    status: "success", 
                    message: `${type} fetched successfully`, 
                    payload: { type, items } 
                });
            } else {
                // Get all inventory types
                const [finishedGoods, rawMaterials, tools, accessories] = await Promise.all([
                    db.finishedGoods.find({}).sort({ createdAt: -1 }),
                    db.rawMaterials.find({}).sort({ createdAt: -1 }),
                    db.tools.find({}).sort({ createdAt: -1 }),
                    db.accessories.find({}).sort({ createdAt: -1 })
                ]);
                
                callback({ 
                    status: "success", 
                    message: "All inventory fetched successfully", 
                    payload: { finishedGoods, rawMaterials, tools, accessories } 
                });
            }
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    // Create inventory item
    socket.on("inventory:create", async (data, callback) => {
        try {
            const { type, itemData } = data;
            const Model = getModelByType(type);
            
            if (!Model) {
                return callback({ status: "error", message: "Invalid inventory type" });
            }
            
            const item = new Model(itemData);
            await item.save();
            
            callback({ 
                status: "success", 
                message: `${type} created successfully`, 
                payload: item 
            });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    // Update inventory item
    socket.on("inventory:update", async (data, callback) => {
        try {
            const { type, id, updateData } = data;
            const Model = getModelByType(type);
            
            if (!Model) {
                return callback({ status: "error", message: "Invalid inventory type" });
            }
            
            const item = await Model.findByIdAndUpdate(id, updateData, { new: true });
            if (!item) {
                return callback({ status: "error", message: "Item not found" });
            }
            
            callback({ 
                status: "success", 
                message: `${type} updated successfully`, 
                payload: item 
            });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    // Delete inventory item
    socket.on("inventory:delete", async (data, callback) => {
        try {
            const { type, id } = data;
            const Model = getModelByType(type);
            
            if (!Model) {
                return callback({ status: "error", message: "Invalid inventory type" });
            }
            
            const item = await Model.findByIdAndDelete(id);
            if (!item) {
                return callback({ status: "error", message: "Item not found" });
            }
            
            callback({ 
                status: "success", 
                message: `${type} deleted successfully`, 
                payload: { id } 
            });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    // Get low stock items
    socket.on("inventory:low-stock", async (data, callback) => {
        try {
            const [finishedGoods, rawMaterials, tools, accessories] = await Promise.all([
                db.finishedGoods.findLowStock(),
                db.rawMaterials.findLowStock(),
                db.tools.findLowStock(),
                db.accessories.findLowStock()
            ]);
            
            callback({ 
                status: "success", 
                message: "Low stock items fetched successfully", 
                payload: { finishedGoods, rawMaterials, tools, accessories } 
            });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    // Update stock
    socket.on("inventory:update-stock", async (data, callback) => {
        try {
            const { type, id, quantity, operation = 'add' } = data;
            const Model = getModelByType(type);
            
            if (!Model) {
                return callback({ status: "error", message: "Invalid inventory type" });
            }
            
            const item = await Model.findById(id);
            if (!item) {
                return callback({ status: "error", message: "Item not found" });
            }
            
            await item.updateStock(quantity, operation);
            
            callback({ 
                status: "success", 
                message: "Stock updated successfully", 
                payload: item 
            });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    // Get inventory statistics
    socket.on("inventory:stats", async (data, callback) => {
        try {
            const [finishedGoodsCount, rawMaterialsCount, toolsCount, accessoriesCount] = await Promise.all([
                db.finishedGoods.countDocuments({ status: 'Active' }),
                db.rawMaterials.countDocuments({ status: 'Active' }),
                db.tools.countDocuments({ status: 'Active' }),
                db.accessories.countDocuments({ status: 'Active' })
            ]);
            
            const [lowStockFinishedGoods, lowStockRawMaterials, lowStockTools, lowStockAccessories] = await Promise.all([
                db.finishedGoods.findLowStock(),
                db.rawMaterials.findLowStock(),
                db.tools.findLowStock(),
                db.accessories.findLowStock()
            ]);
            
            callback({ 
                status: "success", 
                message: "Inventory statistics fetched successfully", 
                payload: {
                    totalItems: {
                        finishedGoods: finishedGoodsCount,
                        rawMaterials: rawMaterialsCount,
                        tools: toolsCount,
                        accessories: accessoriesCount
                    },
                    lowStockItems: {
                        finishedGoods: lowStockFinishedGoods.length,
                        rawMaterials: lowStockRawMaterials.length,
                        tools: lowStockTools.length,
                        accessories: lowStockAccessories.length
                    }
                } 
            });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });
}