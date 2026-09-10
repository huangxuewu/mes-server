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

    return { ...headers, ...config.customHeaders };
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
        uploadBol: async (file, loadNumber, bolNumber) => {
            const authenticationError = "ERP BOL upload requires authentication. Configure the ERP auth token in MES EDI settings, or upload the BOL on the ERP load page.";
            const filename = `${loadNumber}#_${bolNumber}#.pdf`;
            const endpoint = `${config.webBaseUrl.replace(/\/$/, "")}/api/v1/dropbox`;
            const filePath = `/BOL/${filename}`;
            // The ERP uploader replaces this exact file before uploading its new contents.
            const removed = await fetch(`${endpoint}/file`, {
                method: "DELETE", headers: buildHeaders(config), body: JSON.stringify({ path: filePath }), signal: AbortSignal.timeout(30000),
            });
            if (removed.status === 401) throw new Error(authenticationError);
            if (!removed.ok) {
                const failure = await removed.text();
                if (removed.status !== 404 && !failure.includes("path/not_found")) throw new Error(`ERP BOL replacement failed (${removed.status})`);
            }
            const body = new FormData();
            body.append("file", new Blob([file], { type: "application/pdf" }), filename);
            body.append("fileName", filename);
            body.append("destinationPath", "/BOL");
            const headers = buildHeaders(config);
            delete headers["content-type"];
            const response = await fetch(`${endpoint}/upload`, {
                method: "POST", headers, body, signal: AbortSignal.timeout(60000),
            });
            if (response.status === 401) throw new Error(authenticationError);
            const result = await response.json();
            if (!response.ok || !result?.result)
                throw new Error(result?.error || `ERP BOL upload failed (${response.status})`);
            return result.result;
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
