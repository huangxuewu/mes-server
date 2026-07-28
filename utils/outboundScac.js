/** Parcel SCACs (FedEx/UPS) — no BOL required; complete once loaded. */
const NO_BOL_SCACS = new Set(["DMSP"]);

const getShipmentScac = (load) =>
    String(load?.carrierSCAC || load?.executingSCAC || load?.assignedSCAC || "").toUpperCase().trim();

const requiresBol = (load) => !NO_BOL_SCACS.has(getShipmentScac(load));

const shouldMarkCompleted = (load) =>
    !!(load?.bol?.url) || (!requiresBol(load) && !!load?.checklist?.loaded?.status);

module.exports = { NO_BOL_SCACS, getShipmentScac, requiresBol, shouldMarkCompleted };
