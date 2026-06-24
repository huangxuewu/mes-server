/**
 * One-time migration: material.supplier (embedded free-text) -> material.suppliers (link array).
 *
 * Drops the old embedded supplier block and initializes an empty suppliers array.
 * Supplier links are re-entered through the new material UI.
 *
 * Run once:  node server/scripts/migrate-material-suppliers.js
 */
const mongoose = require("../config/database");
const Material = require("../models/material");

(async () => {
    try {
        await mongoose.connection.asPromise();

        const result = await Material.updateMany(
            {},
            { $set: { suppliers: [] }, $unset: { supplier: "" } },
            { strict: false }
        );

        const modified = result.modifiedCount ?? result.nModified ?? 0;
        const matched = result.matchedCount ?? result.n ?? 0;
        console.log(`Materials matched: ${matched}, modified: ${modified}`);
    } catch (error) {
        console.error("Migration failed:", error);
        process.exitCode = 1;
    } finally {
        await mongoose.connection.close();
        process.exit(process.exitCode || 0);
    }
})();
