const mongoose = require('mongoose');
const database = require('../config/database');

// Import models
const Inventory = require('../models/inventory');
const FinishedGoods = require('../models/finishedGoods');
const RawMaterials = require('../models/rawMaterials');
const Tools = require('../models/tools');
const Accessories = require('../models/accessories');

/**
 * Migration script to move inventory data to separate collections
 * This script will:
 * 1. Read all existing inventory items
 * 2. Categorize them based on their category field
 * 3. Create new documents in the appropriate collections
 * 4. Provide a mapping of old IDs to new IDs
 */

async function migrateInventory() {
    try {
        console.log('Starting inventory migration...');
        
        // Get all existing inventory items
        const inventoryItems = await Inventory.find({});
        console.log(`Found ${inventoryItems.length} inventory items to migrate`);
        
        const migrationResults = {
            finishedGoods: [],
            rawMaterials: [],
            tools: [],
            accessories: [],
            errors: []
        };
        
        for (const item of inventoryItems) {
            try {
                let newItem = null;
                let collection = null;
                
                // Map old category to new collection
                switch (item.category) {
                    case 'Finished Goods':
                        newItem = await migrateToFinishedGoods(item);
                        collection = 'finishedGoods';
                        break;
                    case 'Raw Material':
                    case 'Component':
                    case 'Packaging':
                        newItem = await migrateToRawMaterials(item);
                        collection = 'rawMaterials';
                        break;
                    case 'Tool':
                        newItem = await migrateToTools(item);
                        collection = 'tools';
                        break;
                    case 'Accessory':
                        newItem = await migrateToAccessories(item);
                        collection = 'accessories';
                        break;
                    default:
                        console.warn(`Unknown category: ${item.category} for item ${item._id}`);
                        migrationResults.errors.push({
                            oldId: item._id,
                            error: `Unknown category: ${item.category}`
                        });
                        continue;
                }
                
                if (newItem) {
                    migrationResults[collection].push({
                        oldId: item._id,
                        newId: newItem._id,
                        name: item.styleName || item.description || 'Unnamed'
                    });
                    console.log(`Migrated ${item.category}: ${item._id} -> ${newItem._id}`);
                }
                
            } catch (error) {
                console.error(`Error migrating item ${item._id}:`, error.message);
                migrationResults.errors.push({
                    oldId: item._id,
                    error: error.message
                });
            }
        }
        
        // Save migration results
        const fs = require('fs');
        const path = require('path');
        const resultsPath = path.join(__dirname, 'migration-results.json');
        fs.writeFileSync(resultsPath, JSON.stringify(migrationResults, null, 2));
        
        console.log('\nMigration completed!');
        console.log(`Finished Goods: ${migrationResults.finishedGoods.length} items`);
        console.log(`Raw Materials: ${migrationResults.rawMaterials.length} items`);
        console.log(`Tools: ${migrationResults.tools.length} items`);
        console.log(`Accessories: ${migrationResults.accessories.length} items`);
        console.log(`Errors: ${migrationResults.errors.length} items`);
        console.log(`Results saved to: ${resultsPath}`);
        
        return migrationResults;
        
    } catch (error) {
        console.error('Migration failed:', error);
        throw error;
    }
}

async function migrateToFinishedGoods(item) {
    const finishedGoodsData = {
        sku: item.sku,
        upc: item.upc,
        barcode: item.barcode,
        styleCode: item.styleCode,
        styleName: item.styleName || item.description || 'Unnamed Product',
        color: item.color,
        size: item.size,
        totalQuantity: item.totalQuantity,
        availableQuantity: item.availableQuantity,
        reservedQuantity: item.reservedQuantity,
        description: item.description,
        category: 'Final Product', // Default to Final Product
        subcategory: mapSubcategory(item.subcategory, 'finishedGoods'),
        productId: item._id, // Use old ID as product reference for now
        specifications: {
            dimensions: item.customFields?.get('dimensions') || {},
            weight: item.customFields?.get('weight'),
            materials: item.customFields?.get('materials') || [],
            careInstructions: item.customFields?.get('careInstructions'),
            certifications: item.customFields?.get('certifications') || []
        },
        pricing: {
            cost: item.customFields?.get('cost'),
            sellingPrice: item.customFields?.get('sellingPrice'),
            currency: 'USD'
        },
        supplier: item.supplier,
        minStockLevel: item.minStockLevel,
        reorderPoint: item.reorderPoint,
        leadTime: item.leadTime,
        status: item.status,
        property: item.property,
        documents: item.documents || [],
        customFields: item.customFields,
        createdBy: item.createdBy,
        updatedBy: item.updatedBy,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt
    };
    
    return await FinishedGoods.create(finishedGoodsData);
}

async function migrateToRawMaterials(item) {
    const rawMaterialsData = {
        materialCode: item.sku || item.styleCode || `RM-${item._id}`,
        name: item.styleName || item.description || 'Unnamed Material',
        description: item.description,
        category: mapCategory(item.category),
        subcategory: mapSubcategory(item.subcategory, 'rawMaterials'),
        unit: item.customFields?.get('unit') || 'piece',
        totalQuantity: item.totalQuantity,
        availableQuantity: item.availableQuantity,
        reservedQuantity: item.reservedQuantity,
        specifications: {
            color: item.color,
            size: item.size,
            weight: item.customFields?.get('weight'),
            dimensions: item.customFields?.get('dimensions') || {},
            properties: item.customFields || new Map(),
            grade: item.customFields?.get('grade'),
            origin: item.customFields?.get('origin')
        },
        supplier: item.supplier,
        cost: {
            unitCost: item.customFields?.get('unitCost'),
            currency: 'USD',
            lastUpdated: new Date()
        },
        minStockLevel: item.minStockLevel,
        reorderPoint: item.reorderPoint,
        leadTime: item.leadTime,
        status: item.status,
        quality: {
            grade: item.customFields?.get('grade'),
            certifications: item.customFields?.get('certifications') || [],
            batchNumber: item.customFields?.get('batchNumber'),
            expiryDate: item.customFields?.get('expiryDate')
        },
        storage: {
            location: item.customFields?.get('location'),
            temperature: item.customFields?.get('temperature'),
            humidity: item.customFields?.get('humidity'),
            specialRequirements: item.customFields?.get('specialRequirements')
        },
        documents: item.documents || [],
        customFields: item.customFields,
        createdBy: item.createdBy,
        updatedBy: item.updatedBy,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt
    };
    
    return await RawMaterials.create(rawMaterialsData);
}

async function migrateToTools(item) {
    const toolsData = {
        toolCode: item.sku || item.styleCode || `TOOL-${item._id}`,
        name: item.styleName || item.description || 'Unnamed Tool',
        description: item.description,
        category: 'Tool',
        subcategory: mapSubcategory(item.subcategory, 'tools'),
        totalQuantity: item.totalQuantity,
        availableQuantity: item.availableQuantity,
        reservedQuantity: item.reservedQuantity,
        specifications: {
            brand: item.customFields?.get('brand'),
            model: item.customFields?.get('model'),
            serialNumber: item.customFields?.get('serialNumber'),
            dimensions: item.customFields?.get('dimensions') || {},
            weight: item.customFields?.get('weight'),
            operatingVoltage: item.customFields?.get('operatingVoltage'),
            capacity: item.customFields?.get('capacity')
        },
        supplier: item.supplier,
        cost: {
            unitCost: item.customFields?.get('unitCost'),
            currency: 'USD',
            lastUpdated: new Date()
        },
        minStockLevel: item.minStockLevel,
        reorderPoint: item.reorderPoint,
        leadTime: item.leadTime,
        status: item.status,
        maintenance: {
            lastMaintenanceDate: item.customFields?.get('lastMaintenanceDate'),
            nextMaintenanceDate: item.customFields?.get('nextMaintenanceDate'),
            maintenanceInterval: item.customFields?.get('maintenanceInterval'),
            warrantyExpiry: item.customFields?.get('warrantyExpiry')
        },
        location: {
            building: item.customFields?.get('building'),
            floor: item.customFields?.get('floor'),
            room: item.customFields?.get('room'),
            workstation: item.customFields?.get('workstation')
        },
        quality: {
            condition: item.customFields?.get('condition') || 'Good',
            certifications: item.customFields?.get('certifications') || []
        },
        documents: item.documents || [],
        customFields: item.customFields,
        createdBy: item.createdBy,
        updatedBy: item.updatedBy,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt
    };
    
    return await Tools.create(toolsData);
}

async function migrateToAccessories(item) {
    const accessoriesData = {
        accessoryCode: item.sku || item.styleCode || `ACC-${item._id}`,
        name: item.styleName || item.description || 'Unnamed Accessory',
        description: item.description,
        category: 'Accessory',
        subcategory: mapSubcategory(item.subcategory, 'accessories'),
        unit: item.customFields?.get('unit') || 'piece',
        totalQuantity: item.totalQuantity,
        availableQuantity: item.availableQuantity,
        reservedQuantity: item.reservedQuantity,
        specifications: {
            brand: item.customFields?.get('brand'),
            model: item.customFields?.get('model'),
            size: item.size,
            color: item.color,
            material: item.customFields?.get('material'),
            dimensions: item.customFields?.get('dimensions') || {},
            weight: item.customFields?.get('weight'),
            capacity: item.customFields?.get('capacity'),
            concentration: item.customFields?.get('concentration'),
            expiryDate: item.customFields?.get('expiryDate')
        },
        supplier: item.supplier,
        cost: {
            unitCost: item.customFields?.get('unitCost'),
            currency: 'USD',
            lastUpdated: new Date()
        },
        minStockLevel: item.minStockLevel,
        reorderPoint: item.reorderPoint,
        leadTime: item.leadTime,
        status: item.status,
        storage: {
            location: item.customFields?.get('location'),
            temperature: item.customFields?.get('temperature'),
            humidity: item.customFields?.get('humidity'),
            specialRequirements: item.customFields?.get('specialRequirements'),
            shelfLife: item.customFields?.get('shelfLife'),
            batchNumber: item.customFields?.get('batchNumber')
        },
        safety: {
            hazardous: item.customFields?.get('hazardous') || false,
            safetyDataSheet: item.customFields?.get('safetyDataSheet'),
            handlingInstructions: item.customFields?.get('handlingInstructions')
        },
        quality: {
            grade: item.customFields?.get('grade'),
            certifications: item.customFields?.get('certifications') || [],
            condition: item.customFields?.get('condition') || 'New'
        },
        documents: item.documents || [],
        customFields: item.customFields,
        createdBy: item.createdBy,
        updatedBy: item.updatedBy,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt
    };
    
    return await Accessories.create(accessoriesData);
}

function mapCategory(oldCategory) {
    const categoryMap = {
        'Raw Material': 'Raw Material',
        'Component': 'Component',
        'Packaging': 'Packaging'
    };
    return categoryMap[oldCategory] || 'Raw Material';
}

function mapSubcategory(oldSubcategory, targetCollection) {
    if (!oldSubcategory) return null;
    
    const subcategoryMaps = {
        finishedGoods: {
            'Final Product': 'Other',
            'Semi-Finished': 'Other',
            'Pillow': 'Pillow'
        },
        rawMaterials: {
            'Fabric': 'Fabric',
            'Fiber': 'Fiber',
            'Thread': 'Thread',
            'Needle': 'Needle',
            'Corrugated Box': 'Corrugated Box',
            'Pallet': 'Pallet',
            'Poly Bag': 'Poly Bag',
            'Label': 'Label',
            'Tape': 'Tape',
            'Container': 'Container',
            'Wrap': 'Wrap',
            'Divider': 'Divider',
            'Other Packaging': 'Other'
        },
        tools: {
            'Tool': 'Hand Tool',
            'Machine Part': 'Machine Part',
            'Lubricant': 'Other',
            'Cleaning Supply': 'Other'
        },
        accessories: {
            'Tool': 'Other',
            'Machine Part': 'Other',
            'Lubricant': 'Oil',
            'Cleaning Supply': 'Detergent'
        }
    };
    
    return subcategoryMaps[targetCollection]?.[oldSubcategory] || 'Other';
}

// Run migration if this script is executed directly
if (require.main === module) {
    migrateInventory()
        .then(() => {
            console.log('Migration completed successfully');
            process.exit(0);
        })
        .catch((error) => {
            console.error('Migration failed:', error);
            process.exit(1);
        });
}

module.exports = { migrateInventory };
