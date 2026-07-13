/**
 * One-time migration: legacy packaging fields → storageUnit-aware storage schema.
 * Run: node server/scripts/migrate-material-packaging.js
 */
const database = require("../config/database");
require("../models/material");

const Material = database.model("material");

const run = async () => {
    const materials = await Material.find({});
    let updated = 0;

    for (const material of materials) {
        const storage = material.storage?.toObject?.() ?? material.storage ?? {};
        const casePack = Number(storage.casePack) || 0;
        const unitsPerBox = Number(storage.unitsPerBox) || casePack || 0;
        const legacyUnitsPerPallet = Number(storage.unitsPerPallet) || 0;
        const boxesPerPallet = Number(storage.boxesPerPallet) || 0;

        const hasBoxChain = casePack > 0 || unitsPerBox > 0 || boxesPerPallet > 0;
        const storageUnit = storage.storageUnit
            || ((!hasBoxChain && legacyUnitsPerPallet > 0) ? 'piece' : 'box');

        const next = {
            ...storage,
            storageUnit,
            casePack,
            unitsPerBox,
            boxesPerPallet: storageUnit === 'piece' ? 0 : (boxesPerPallet || legacyUnitsPerPallet),
            unitsPerPallet: storageUnit === 'piece' ? (legacyUnitsPerPallet || boxesPerPallet) : (Number(storage.unitsPerPallet) || 0),
            defaultPickLevel: storage.defaultPickLevel || (storageUnit === 'piece' ? 'piece' : 'box'),
        };

        const changed = JSON.stringify(storage) !== JSON.stringify(next);
        if (!changed) continue;

        material.storage = next;
        material.markModified('storage');
        await material.save();
        updated += 1;
    }

    console.log(`Migrated ${updated} material(s).`);
    process.exit(0);
};

run().catch(err => {
    console.error(err);
    process.exit(1);
});
