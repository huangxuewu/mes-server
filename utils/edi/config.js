const db = require("../../models");

const EDI_CONFIG_KEYS = {
    baseUrl: "integration.edi.baseUrl",
    authToken: "integration.edi.authToken",
    webBaseUrl: "integration.edi.webBaseUrl",
};

const DEFAULTS = {
    baseUrl: "https://erp-api.downhomeusa.com",
    webBaseUrl: "https://erp.downhomeusa.com",
};

const normalizeValue = value => String(value ?? "").trim();

const toConfigMap = (docs = []) =>
    docs.reduce((acc, doc) => Object.assign(acc, { [doc.key]: normalizeValue(doc.value) }), {});

const fetchEdiConfigDocs = () =>
    db.config.find({
        key: { $in: Object.values(EDI_CONFIG_KEYS) },
        status: "Active",
    }, {
        key: 1,
        value: 1,
    }).lean();

const resolveEdiConfig = (docs = []) => {
    const configMap = toConfigMap(docs);

    return {
        baseUrl: normalizeValue(process.env.EDI_API_BASE_URL)
            || configMap[EDI_CONFIG_KEYS.baseUrl]
            || DEFAULTS.baseUrl,
        authToken: normalizeValue(process.env.EDI_API_AUTH_TOKEN)
            || configMap[EDI_CONFIG_KEYS.authToken]
            || "",
        webBaseUrl: normalizeValue(process.env.EDI_WEB_BASE_URL)
            || configMap[EDI_CONFIG_KEYS.webBaseUrl]
            || DEFAULTS.webBaseUrl,
    };
};

const getEdiConfig = async () => resolveEdiConfig(await fetchEdiConfigDocs());

module.exports = {
    EDI_CONFIG_KEYS,
    DEFAULTS,
    resolveEdiConfig,
    getEdiConfig,
};
