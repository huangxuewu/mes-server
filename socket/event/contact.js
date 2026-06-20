const db = require("../../models");

const toMapPayload = (customFields) => {
    if (!customFields) return undefined;
    if (customFields instanceof Map) return customFields;
    if (Array.isArray(customFields)) return new Map(customFields);
    if (typeof customFields === "object") return new Map(Object.entries(customFields));
    return undefined;
};

const normalizePayload = (data) => {
    const payload = { ...data };
    const customFields = toMapPayload(payload.customFields);
    if (customFields) payload.customFields = customFields;
    return payload;
};

module.exports = (socket, io) => {
    socket.on("contact:fetch", async (query = {}, callback) => {
        try {
            const contacts = await db.contact.find(query).sort({ "businessInfo.companyName": 1, lastName: 1, firstName: 1 });
            callback({ status: "success", message: "Contacts fetched", payload: contacts });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on("contact:get", async (query, callback) => {
        try {
            const contact = await db.contact.findOne(query);
            if (!contact) return callback({ status: "error", message: "Contact not found" });
            callback({ status: "success", message: "Contact fetched", payload: contact });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on("contact:companyContacts", async ({ _id }, callback) => {
        try {
            const contact = await db.contact.findById(_id);
            if (!contact) return callback({ status: "error", message: "Contact not found" });

            const companyId = contact.businessInfo?.companyId || contact._id;
            const contacts = await db.contact.getCompanyContacts(companyId);
            callback({ status: "success", message: "Company contacts fetched", payload: contacts });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on("contact:create", async (data, callback) => {
        try {
            const contact = await db.contact.create(normalizePayload(data));
            callback({ status: "success", message: "Contact created", payload: contact });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on("contact:update", async ({ _id, ...data }, callback) => {
        try {
            const contact = await db.contact.findByIdAndUpdate(_id, { $set: normalizePayload(data) }, { new: true, runValidators: true });
            if (!contact) return callback({ status: "error", message: "Contact not found" });
            callback({ status: "success", message: "Contact updated", payload: contact });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on("contact:delete", async ({ _id }, callback) => {
        try {
            const result = await db.contact.deleteOne({ _id });
            if (!result.deletedCount) return callback({ status: "error", message: "Contact not found" });
            callback({ status: "success", message: "Contact deleted" });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });
};
