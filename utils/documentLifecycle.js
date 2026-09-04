const db = require("../models");

const LIFECYCLE_INTERVAL_MS = 15 * 60 * 1000;

const refreshDocumentLifecycle = async (io) => {
    const now = new Date();
    const active = await db.document.find({
        isTemplate: false,
        status: { $in: ["Published", "Review Overdue", "Expired"] },
    });

    for (const document of active) {
        let nextStatus = "Published";
        if (document.expiresAt && document.expiryBehavior === "Deactivate" && document.expiresAt <= now)
            nextStatus = "Expired";
        else if (document.reviewDueAt && document.reviewDueAt <= now)
            nextStatus = "Review Overdue";

        if (document.status === nextStatus) continue;
        document.status = nextStatus;
        await document.save();
        const payload = await db.document.findById(document._id)
            .populate("auditReferences", "name code description status sourceLinks")
            .populate("owner", "username displayName firstName lastName")
            .populate("updatedBy", "username displayName firstName lastName")
            .lean();
        io.emit("document:updated", payload);
    }
};

const startDocumentLifecycle = (io) => {
    refreshDocumentLifecycle(io).catch((error) => console.error("Document lifecycle:", error.message));
    const timer = setInterval(() => {
        refreshDocumentLifecycle(io).catch((error) => console.error("Document lifecycle:", error.message));
    }, LIFECYCLE_INTERVAL_MS);
    timer.unref?.();
    return timer;
};

module.exports = {
    refreshDocumentLifecycle,
    startDocumentLifecycle,
};
