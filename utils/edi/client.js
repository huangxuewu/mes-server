const axios = require("axios");
const { getEdiConfig } = require("./config");

const buildHeaders = (config, extra = {}) => {
    const headers = {
        accept: "application/json",
        "content-type": "application/json",
        ...extra,
    };

    if (config.authToken)
        headers.authorization = config.authToken.startsWith("Bearer ")
            ? config.authToken
            : `Bearer ${config.authToken}`;

    return headers;
};

const getClient = async () => {
    const config = await getEdiConfig();
    const baseURL = config.baseUrl.replace(/\/$/, "");

    return {
        config,
        headers: buildHeaders(config),
        graphql: async (query, variables = {}) => {
            const { data } = await axios.post(
                `${baseURL}/graphql`,
                { query, variables },
                { headers: buildHeaders(config), timeout: 30000 }
            );

            if (data?.errors?.length)
                throw new Error(data.errors.map(e => e.message).join("; ") || "EDI GraphQL error");

            return data?.data;
        },
        generateLabels: async (payload) => {
            const response = await axios.post(
                `${baseURL}/api/v1/edi/labels/generate`,
                payload,
                {
                    headers: buildHeaders(config, { accept: "application/pdf, application/json" }),
                    responseType: "arraybuffer",
                    timeout: 60000,
                    validateStatus: () => true,
                }
            );

            const buffer = Buffer.from(response.data || []);
            const contentType = String(response.headers["content-type"] || "");
            const isPdf = contentType.includes("pdf") || buffer.subarray(0, 4).toString() === "%PDF";

            if (response.status >= 400 || !isPdf) {
                const message = buffer.toString("utf8") || `EDI label API failed (${response.status})`;
                const err = new Error(message);
                err.status = response.status >= 400 ? response.status : 502;
                throw err;
            }

            return buffer;
        },
    };
};

module.exports = { getClient, buildHeaders };
