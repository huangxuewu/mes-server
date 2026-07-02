const db = require("../../models");
const mongoose = require("mongoose");

const toIdStr = (id) => (id ? String(id) : '');

const normalizeMaterialIds = (ids = []) =>
    [...new Set((ids || []).map(toIdStr).filter(Boolean))];

const syncCatalogMaterials = async (catalogId, materialIds, previousMaterialIds = []) => {
    const catalogIdStr = toIdStr(catalogId);
    const nextIds = normalizeMaterialIds(materialIds);
    const prevIds = normalizeMaterialIds(previousMaterialIds);
    const removedIds = prevIds.filter(id => !nextIds.includes(id));

    if (nextIds.length) {
        const nextObjectIds = nextIds.map(id => new mongoose.Types.ObjectId(id));
        const linked = await db.material.find({
            _id: { $in: nextObjectIds },
            catalogId: { $ne: null }
        }).select('_id name code catalogId');

        const conflicts = linked.filter(m => toIdStr(m.catalogId) !== catalogIdStr);
        if (conflicts.length)
            throw new Error(`Material already linked to another catalog: ${conflicts.map(m => m.code || m.name).join(', ')}`);
    }

    if (removedIds.length)
        await db.material.updateMany(
            { _id: { $in: removedIds.map(id => new mongoose.Types.ObjectId(id)) }, catalogId: new mongoose.Types.ObjectId(catalogIdStr) },
            { $set: { catalogId: null } }
        );

    if (nextIds.length)
        await db.material.updateMany(
            { _id: { $in: nextIds.map(id => new mongoose.Types.ObjectId(id)) } },
            { $set: { catalogId: new mongoose.Types.ObjectId(catalogIdStr) } }
        );
};

const clearCatalogFromMaterials = async (catalogId, materialIds = []) => {
    const ids = normalizeMaterialIds(materialIds);
    if (!ids.length) return;

    await db.material.updateMany(
        { _id: { $in: ids.map(id => new mongoose.Types.ObjectId(id)) }, catalogId: new mongoose.Types.ObjectId(catalogId) },
        { $set: { catalogId: null } }
    );
};

module.exports = (socket) => {
    socket.on('materialCatalog:create', async (payload, callback) => {
        try {
            const { materialIds, ...data } = payload;
            const catalog = await db.materialCatalog.create({ ...data, materialIds: normalizeMaterialIds(materialIds) });
            await syncCatalogMaterials(catalog._id, catalog.materialIds, []);
            const updated = await db.materialCatalog.findById(catalog._id);
            callback({ status: "success", message: "Material catalog created successfully", payload: updated });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on('materialCatalog:update', async (payload, callback) => {
        try {
            const { _id, materialIds, ...update } = payload;
            const existing = await db.materialCatalog.findById(_id);
            if (!existing) return callback({ status: "error", message: "Material catalog not found" });

            const nextMaterialIds = materialIds !== undefined
                ? normalizeMaterialIds(materialIds)
                : existing.materialIds.map(toIdStr);

            await syncCatalogMaterials(_id, nextMaterialIds, existing.materialIds);

            const catalog = await db.materialCatalog.findByIdAndUpdate(
                _id,
                { $set: { ...update, materialIds: nextMaterialIds } },
                { new: true }
            );
            callback({ status: "success", message: "Material catalog updated successfully", payload: catalog });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on('materialCatalog:delete', async (payload, callback) => {
        try {
            const { _id } = payload;
            const existing = await db.materialCatalog.findById(_id);
            if (!existing) return callback({ status: "error", message: "Material catalog not found" });

            await clearCatalogFromMaterials(_id, existing.materialIds);
            await db.materialCatalog.findByIdAndDelete(_id);
            callback({ status: "success", message: "Material catalog deleted successfully" });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on('materialCatalog:get', async (query, callback) => {
        try {
            const catalog = await db.materialCatalog.findOne(query);
            callback({ status: "success", message: "Material catalog fetched successfully", payload: catalog });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on('materialCatalog:fetch', async (query = {}, callback) => {
        try {
            const catalogs = await db.materialCatalog.find(query).sort({ name: 1 });
            callback({ status: "success", message: "Material catalogs fetched successfully", payload: catalogs });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });
};
