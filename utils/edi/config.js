const db = require("../../models");

const EDI_CONFIG_KEYS = {
    baseUrl: "integration.edi.baseUrl",
    authToken: "integration.edi.authToken",
    webBaseUrl: "integration.edi.webBaseUrl",
    customFields: "integration.edi.customFields",
};

const DEFAULTS = {
    baseUrl: "https://erp-api.downhomeusa.com",
    webBaseUrl: "https://erp.downhomeusa.com",
};

const normalizeValue = value => String(value ?? "").trim();

const toConfigMap = (docs = []) =>
    docs.reduce((acc, doc) => Object.assign(acc, { [doc.key]: doc.value }), {});

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
        baseUrl: normalizeValue(configMap[EDI_CONFIG_KEYS.baseUrl])
            || DEFAULTS.baseUrl,
        authToken: normalizeValue(configMap[EDI_CONFIG_KEYS.authToken])
            || "",
        webBaseUrl: normalizeValue(configMap[EDI_CONFIG_KEYS.webBaseUrl])
            || DEFAULTS.webBaseUrl,
        customHeaders: Object.fromEntries(
            (Array.isArray(configMap[EDI_CONFIG_KEYS.customFields]) ? configMap[EDI_CONFIG_KEYS.customFields] : [])
                .filter(field => normalizeValue(field?.key))
                .map(field => [normalizeValue(field.key).toLowerCase(), String(field.value ?? "")])
        ),
    };
};

const getEdiConfig = async () => resolveEdiConfig(await fetchEdiConfigDocs());

module.exports = {
    EDI_CONFIG_KEYS,
    DEFAULTS,
    resolveEdiConfig,
    getEdiConfig,
};
