const db = require('../models');

const normalizeItems = (items = []) => {
    return (items || []).map((item) => ({
        ...item,
        isAppend: Boolean(item?.isAppend ?? item?.isAdditional),
        appendAt: item?.appendAt || item?.addedAt || null,
        appendBy: item?.appendBy || item?.addedBy || null,
    }));
};

const normalizeDocuments = (documents = []) => {
    return (documents || []).map((doc) => ({
        ...doc,
        items: normalizeItems(doc?.items),
    }));
};

async function migrateInboundAdditionalFields() {
    try {
        console.log('Starting inbound additional-item field migration...');
        const shipments = await db.inbound.find({}, { _id: 1, documents: 1 }).lean();
        console.log(`Found ${shipments.length} inbound shipment(s)`);

        let updated = 0;
        for (const shipment of shipments) {
            const documents = normalizeDocuments(shipment.documents || []);
            await db.inbound.updateOne({ _id: shipment._id }, { $set: { documents } });
            updated += 1;
        }

        console.log(`Migration completed. Updated ${updated} shipment(s).`);
        process.exit(0);
    } catch (error) {
        console.error('Migration failed:', error.message);
        process.exit(1);
    }
}

migrateInboundAdditionalFields();
