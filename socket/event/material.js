const db = require("../../models");
const { normalizeStorage, validateStorage } = require("../../utils/materialPackaging");

const applyStorage = (payload = {}) => {
    if (!payload.storage) return payload;
    const { normalized, errors } = validateStorage(payload.storage);
    if (errors.length) throw new Error(errors[0]);
    return { ...payload, storage: normalized };
};

module.exports = (socket, io) => {

    socket.on('material:create', async (payload, callback) => {
        try {
            const material = await db.material.create(applyStorage(payload));
            callback({ status: "success", message: "Material created successfully", payload: material })
        } catch (error) {
            callback({ status: "error", message: error.message })
        }
    });

    socket.on('material:update', async (payload, callback) => {
        try {
            const { _id, ...update } = applyStorage(payload);
            const material = await db.material.findByIdAndUpdate(_id, { $set: update }, { new: true });
            callback({ status: "success", message: "Material updated successfully", payload: material })
        } catch (error) {
            callback({ status: "error", message: error.message })
        }
    });

    socket.on('material:delete', async (payload, callback) => {
        try {
            const { _id } = payload;
            await db.material.findByIdAndDelete(_id);
            callback({ status: "success", message: "Material deleted successfully" })
        } catch (error) {
            callback({ status: "error", message: error.message })
        }
    });

    socket.on('material:get', async (query, callback) => {
        try {
            const material = await db.material.findOne(query);
            callback({ status: "success", message: "Material fetched successfully", payload: material })
        } catch (error) {
            callback({ status: "error", message: error.message })
        }
    });

    socket.on('material:fetch', async (query = {}, callback) => {
        try {
            const materials = await db.material.find(query);
            const payload = materials.map(m => {
                const doc = m.toObject();
                if (doc.storage) doc.storage = validateStorage(doc.storage).normalized;
                return doc;
            });
            callback({ status: "success", message: "Materials fetched successfully", payload })
        } catch (error) {
            callback({ status: "error", message: error.message })
        }
    });
}