const db = require("../models");

const APPOINTMENT_AI_KEYS = {
    provider: "integration.appointment.ai.provider",
    enabled: "integration.appointment.ai.enabled",
    apiKey: "integration.appointment.ai.apiKey"
};

const normalizeValue = value => String(value ?? "").trim();

const parseEnabled = value =>
    value === true || value === "true" || value === 1 || value === "1";

const toConfigMap = (docs = []) =>
    docs.reduce((acc, doc) => Object.assign(acc, { [doc.key]: doc.value }), {});

const fetchAppointmentAiConfig = async () => {
    const docs = await db.config.find({ key: { $in: Object.values(APPOINTMENT_AI_KEYS) } });
    const configMap = toConfigMap(docs);
    const apiKey = normalizeValue(configMap[APPOINTMENT_AI_KEYS.apiKey]);
    const enabled = parseEnabled(configMap[APPOINTMENT_AI_KEYS.enabled]);

    return {
        provider: normalizeValue(configMap[APPOINTMENT_AI_KEYS.provider]) || "deepseek",
        enabled,
        apiKey,
        useAi: enabled && !!apiKey
    };
};

module.exports = { APPOINTMENT_AI_KEYS, fetchAppointmentAiConfig };
