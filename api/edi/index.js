const express = require("express");
const { findShipments, generateShippingLabelsPdf } = require("../../utils/edi");

const router = express.Router();

const normalize = value => String(value ?? "").trim();

const sendError = (res, error) => {
    const status = error?.status || 500;
    const body = {
        status: "error",
        message: error?.message || "Unknown EDI error",
    };

    if (error?.code) body.code = error.code;
    if (error?.shipIqCartons != null) body.shipIqCartons = error.shipIqCartons;
    if (error?.loadPackings != null) body.loadPackings = error.loadPackings;
    if (error?.shipments) body.shipments = error.shipments;

    res.status(status).json(body);
};

router.get("/shipments", async (req, res) => {
    try {
        const loadNumber = normalize(req.query.loadNumber);
        const poDc = normalize(req.query.poDc) || undefined;

        if (!loadNumber)
            return res.status(400).json({ status: "error", message: "loadNumber is required" });

        const shipments = await findShipments({ loadNumber, poDc });
        res.json(shipments.map(({ node, ...rest }) => rest));
    } catch (error) {
        sendError(res, error);
    }
});

router.post("/shipping-label", async (req, res) => {
    try {
        const loadNumber = normalize(req.body?.loadNumber);
        const poDc = normalize(req.body?.poDc) || undefined;
        const poDcs = Array.isArray(req.body?.poDcs)
            ? req.body.poDcs.map(normalize).filter(Boolean)
            : undefined;

        if (!loadNumber)
            return res.status(400).json({ status: "error", message: "loadNumber is required" });

        if (!poDc && !poDcs?.length)
            return res.status(400).json({ status: "error", message: "poDc or poDcs is required" });

        const { pdf, filename } = await generateShippingLabelsPdf({ loadNumber, poDc, poDcs });

        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", `inline; filename="${filename}"`);
        res.send(pdf);
    } catch (error) {
        sendError(res, error);
    }
});

module.exports = router;
