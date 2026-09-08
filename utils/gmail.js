const google = require("googleapis/build/src/apis/gmail");
const db = require("../models");
const { createHash, randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { createGmailQuota, GmailDeferred } = require('./gmailQuota');
const { prepareGmailMailbox } = require('./gmailMailbox');

let quota;
const authClients = new Map();
const hash = value => createHash('sha256').update(value).digest('hex');

const SEARCH_QUERY = "newer_than:14d -category:{promotions social}";
const PRIORITY_REFERENCE_BATCH_SIZE = 30;

const GMAIL_CONFIG_KEYS = {
    clientId: "integration.gmail.clientId",
    clientSecret: "integration.gmail.clientSecret",
    refreshToken: "integration.gmail.refreshToken",
    redirectUri: "integration.gmail.redirectUri",
    redirectUriDev: "integration.gmail.redirectUri.dev"
};

const GMAIL_OAUTH_SCOPES = [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.send"
];

const OAUTH_CLIENT_CONFIG_KEYS = [
    GMAIL_CONFIG_KEYS.clientId,
    GMAIL_CONFIG_KEYS.clientSecret,
    GMAIL_CONFIG_KEYS.redirectUri,
    GMAIL_CONFIG_KEYS.redirectUriDev
];

const isProductionServer = () => process.env.NODE_ENV === "production";

const isLocalHost = host => /localhost|127\.0\.0\.1/i.test(host || "");

const normalizeValue = value => String(value ?? "").trim();

const escapeSearchPhrase = value => normalizeValue(value).replace(/["\\]/g, "\\$&");

const buildPrioritySearchQueries = (references = []) => {
    const unique = [...new Set(references.map(normalizeValue).filter(Boolean))];
    const queries = [];

    for (let index = 0; index < unique.length; index += PRIORITY_REFERENCE_BATCH_SIZE) {
        const terms = unique
            .slice(index, index + PRIORITY_REFERENCE_BATCH_SIZE)
            .map(reference => `"${escapeSearchPhrase(reference)}"`);
        queries.push(`{${terms.join(" ")}}`);
    }

    return queries;
};

const getOverrideValue = (overrides, key) =>
    normalizeValue(overrides?.[key] ?? overrides?.[GMAIL_CONFIG_KEYS[key]]);

const toConfigMap = (docs = []) =>
    docs.reduce((acc, doc) => Object.assign(acc, { [doc.key]: normalizeValue(doc.value) }), {});

const resolveRedirectUri = (configMap, overrides = {}, { host } = {}) => {
    const override = getOverrideValue(overrides, "redirectUri");
    if (override) return override;

    if (host) {
        const local = isLocalHost(host);
        return local
            ? configMap[GMAIL_CONFIG_KEYS.redirectUriDev] || configMap[GMAIL_CONFIG_KEYS.redirectUri] || ""
            : configMap[GMAIL_CONFIG_KEYS.redirectUri] || configMap[GMAIL_CONFIG_KEYS.redirectUriDev] || "";
    }

    return isProductionServer()
        ? configMap[GMAIL_CONFIG_KEYS.redirectUri] || configMap[GMAIL_CONFIG_KEYS.redirectUriDev] || ""
        : configMap[GMAIL_CONFIG_KEYS.redirectUriDev] || configMap[GMAIL_CONFIG_KEYS.redirectUri] || "";
};

const resolveGmailConfig = (docs = [], overrides = {}) => {
    const configMap = toConfigMap(docs);

    const config = {
        clientId: getOverrideValue(overrides, "clientId") || configMap[GMAIL_CONFIG_KEYS.clientId] || "",
        clientSecret: getOverrideValue(overrides, "clientSecret") || configMap[GMAIL_CONFIG_KEYS.clientSecret] || "",
        refreshToken: getOverrideValue(overrides, "refreshToken") || configMap[GMAIL_CONFIG_KEYS.refreshToken] || "",
        redirectUri: resolveRedirectUri(configMap, overrides)
    };

    const missing = Object.entries(config)
        .filter(([, value]) => !value)
        .map(([key]) => GMAIL_CONFIG_KEYS[key]);

    if (missing.length) throw new Error(`Missing Gmail config: ${missing.join(", ")}`);

    return config;
};

const resolveGmailOAuthClientConfig = (docs = [], overrides = {}, options = {}) => {
    const configMap = toConfigMap(docs);
    const redirectUri = resolveRedirectUri(configMap, overrides, options);

    const config = {
        clientId: getOverrideValue(overrides, "clientId") || configMap[GMAIL_CONFIG_KEYS.clientId] || "",
        clientSecret: getOverrideValue(overrides, "clientSecret") || configMap[GMAIL_CONFIG_KEYS.clientSecret] || "",
        redirectUri
    };

    const missing = Object.entries(config)
        .filter(([, value]) => !value)
        .map(([key]) => key === "redirectUri" ? GMAIL_CONFIG_KEYS.redirectUri : GMAIL_CONFIG_KEYS[key]);

    if (missing.length) throw new Error(`Missing Gmail OAuth config: ${missing.join(", ")}`);

    return config;
};

const fetchGmailConfigDocs = () =>
    db.config.find({
        key: { $in: Object.values(GMAIL_CONFIG_KEYS) },
        status: "Active"
    }, {
        key: 1,
        value: 1
    }).lean();

const fetchGmailOAuthClientConfigDocs = () =>
    db.config.find({
        key: { $in: OAUTH_CLIENT_CONFIG_KEYS },
        status: "Active"
    }, {
        key: 1,
        value: 1
    }).lean();

const createOAuth2Client = (config) =>
    new google.auth.OAuth2(config.clientId, config.clientSecret, config.redirectUri);

const getGmailAuthUrl = async (overrides = {}) => {
    const docs = await fetchGmailOAuthClientConfigDocs();
    const config = resolveGmailOAuthClientConfig(docs, overrides);
    return createOAuth2Client(config).generateAuthUrl({
        access_type: "offline",
        prompt: "consent",
        scope: GMAIL_OAUTH_SCOPES
    });
};

const exchangeGmailAuthCode = async (code, overrides = {}, options = {}) => {
    const docs = await fetchGmailOAuthClientConfigDocs();
    const config = resolveGmailOAuthClientConfig(docs, overrides, options);
    const { tokens } = await createOAuth2Client(config).getToken(code);
    if (!tokens.refresh_token) throw new Error("No refresh token returned. Revoke Google access and authorize again.");
    return normalizeValue(tokens.refresh_token);
};

const saveGmailRefreshToken = async (refreshToken) => {
    const key = GMAIL_CONFIG_KEYS.refreshToken;
    const config = await db.config.findOneAndUpdate(
        { key },
        {
            $set: {
                value: normalizeValue(refreshToken),
                "audit.updatedBy": "gmail.oauth",
                "audit.changeNote": "Gmail OAuth refresh token"
            }
        },
        { new: true }
    );

    if (!config) throw new Error(`Config document not found for ${key}`);

    return config;
};

const getClient = async (overrides = {}) => {
    const docs = await fetchGmailConfigDocs();
    const config = resolveGmailConfig(docs, overrides);
    const authKey = hash(JSON.stringify(config));
    let auth = authClients.get(authKey);
    if (!auth) {
        auth = createOAuth2Client(config);
        auth.setCredentials({ refresh_token: config.refreshToken });
        if (authClients.size >= 8) authClients.clear();
        authClients.set(authKey, auth);
    }
    const connection = db.config.db;
    quota ||= createGmailQuota({ connection });
    const project = process.env.GMAIL_QUOTA_PROJECT || config.clientId.match(/^(\d+)-/)?.[1];
    if (!project) throw new Error('Set GMAIL_QUOTA_PROJECT to the Gmail Cloud project number');
    const identityKey = hash(`${config.clientId}:${config.refreshToken}`);
    const identities = connection.db.collection('gmailIdentity');
    const identity = await identities.findOne({ _id: identityKey });
    const context = { project, mailbox: identity?.mailbox || null };
    // Fetch auth separately: OAuth2Client.request may retry a Gmail 403 outside our quota gate.
    const gmail = google.gmail({ version: 'v1' });
    const request = async (method, params = {}, options = {}) => {
        const { token } = await auth.getAccessToken();
        if (!token) throw new Error('Gmail authorization returned no access token');
        const path = method.split('.');
        const resource = path.slice(0, -1).reduce((value, key) => value[key], gmail.users);
        return quota.run(context, method, async transport => {
            const dispatchStarted = performance.now();
            if (options.beforeDispatch) await options.beforeDispatch();
            if (performance.now() - dispatchStarted > 500) throw new GmailDeferred(Date.now() + 1000, 'lateDispatch');
            return resource[path.at(-1)]({ userId: 'me', ...params }, {
                ...transport, headers: { Authorization: `Bearer ${token}` },
            });
        }, options);
    };
    const profile = async (fresh = false, options = {}) => {
        if (!fresh && identity?.emailAddress) {
            return identity;
        }
        const { data } = await request('getProfile', {}, options);
        context.mailbox = hash(data.emailAddress.toLowerCase());
        await identities.updateOne({ _id: identityKey }, { $set: {
            mailbox: context.mailbox, emailAddress: data.emailAddress,
        } }, { upsert: true });
        return data;
    };
    return { request, profile, context, connection, identityKey };
};

const getHeader = (message, name) =>
    message.payload?.headers?.find(h => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";

const decodeBody = data => Buffer.from(data, "base64url").toString("utf8");

const findPart = (payload, mimeType) => {
    if (!payload) return null;
    if (payload.mimeType === mimeType && payload.body?.data) return payload.body.data;
    for (const part of payload.parts ?? []) {
        const found = findPart(part, mimeType);
        if (found) return found;
    }
    return null;
};

// Preserve line breaks so emailWeight can segment the body into sections
const stripHtml = html => html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

// Quoted reply chains are weighted downstream (utils/emailWeight), not cut here —
// the stored body keeps the whole conversation so operators can expand it.
const BODY_CHAR_CAP = 12000;

const extractBody = (message) => {
    const plain = findPart(message.payload, "text/plain");
    const html = plain ? null : findPart(message.payload, "text/html");
    const body = plain ? decodeBody(plain) : html ? stripHtml(decodeBody(html)) : message.snippet ?? "";
    return body.trim().slice(0, BODY_CHAR_CAP);
};

const toMessage = message => ({
    messageId: message.id,
    threadId: message.threadId,
    from: getHeader(message, "From"),
    to: getHeader(message, "To"),
    subject: getHeader(message, "Subject"),
    date: new Date(Number(message.internalDate)),
    rfcMessageId: getHeader(message, "Message-ID"),
    body: extractBody(message),
});

const getProfileEmail = async (overrides = {}) => {
    const client = await getClient(overrides);
    return (await client.profile(true, { urgent: true })).emailAddress;
};

// Sends an email; pass threadId + inReplyTo to reply in-thread, omit both for a fresh email
const sendEmail = async ({ operationId, threadId, to, subject, body, inReplyTo }, overrides = {}) => {
    if (!/^[a-zA-Z0-9-]{16,80}$/.test(operationId || '')) throw new Error('A valid email operation ID is required');
    const client = await getClient(overrides);
    const from = (await client.profile(false, { urgent: true })).emailAddress;
    await prepareGmailMailbox(client.connection, client.context.mailbox);
    const sends = client.connection.db.collection('gmailSend');
    const id = `${client.context.project}:${client.context.mailbox}:${operationId}`;
    // Reply headers may advance while an uncertain send is reconciled; bind the operator's content.
    const fingerprint = hash(JSON.stringify({ to, subject: subject.replace(/^Re:\s*/i, ''), body }));
    const messageId = `<${operationId}@mes.local>`;
    try {
        await sends.updateOne({ _id: id }, { $setOnInsert: { fingerprint, status: 'pending', messageId } }, { upsert: true });
    } catch (error) { if (error.code !== 11000) throw error; }
    const operation = await sends.findOne({ _id: id });
    if (operation.fingerprint !== fingerprint) throw new Error('Email operation ID was reused with different content');
    if (operation.status === 'sent') return operation.result;
    if (operation.status !== 'pending') {
        const { data } = await client.request('messages.list', { q: `in:sent rfc822msgid:${operationId}@mes.local`, maxResults: 2 }, { urgent: true });
        if (!data.messages?.length) throw Object.assign(new Error('Email delivery is unconfirmed; check Sent mail before trying a new send'),
            { code: 'GMAIL_SEND_UNCERTAIN' });
        const { data: sent } = await client.request('messages.get', { id: data.messages[0].id, format: 'full' }, { urgent: true });
        const result = { ...toMessage(sent), mailbox: client.context.mailbox };
        await sends.updateOne({ _id: id }, { $set: { status: 'sent', result } });
        return result;
    }

    const headers = [
        `From: ${from}`,
        `To: ${to}`,
        `Subject: ${subject}`,
        `Message-ID: ${messageId}`,
        "Content-Type: text/plain; charset=utf-8",
    ];
    if (inReplyTo) headers.push(`In-Reply-To: ${inReplyTo}`, `References: ${inReplyTo}`);

    const raw = Buffer.from(`${headers.join("\r\n")}\r\n\r\n${body}`).toString("base64url");
    const owner = randomUUID();
    try {
        const { data } = await client.request('messages.send', {
            requestBody: { raw, ...(threadId ? { threadId } : {}) },
        }, { urgent: true, beforeDispatch: async () => {
            const claimed = await sends.updateOne({ _id: id, status: 'pending' },
                { $set: { status: 'sending', owner, startedAt: new Date() } }, { writeConcern: { w: 'majority' } });
            if (!claimed.modifiedCount) throw new Error('Email send is already in progress; check its status before retrying');
        } });
        const result = { messageId: data.id, threadId: data.threadId, mailbox: client.context.mailbox, from, to, subject,
            body, date: new Date(), rfcMessageId: messageId };
        await sends.updateOne({ _id: id, owner }, { $set: { status: 'sent', result } }, { writeConcern: { w: 'majority' } });
        return result;
    } catch (error) {
        // Even a crash between dispatch and saving success must never permit a second send.
        const notDispatched = error instanceof GmailDeferred && error.reason === 'lateDispatch';
        const uncertain = await sends.updateOne({ _id: id, owner, status: 'sending' },
            { $set: { status: notDispatched ? 'pending' : 'uncertain' } });
        if (uncertain.modifiedCount && !notDispatched) error.code = 'GMAIL_SEND_UNCERTAIN';
        throw error;
    }
};

module.exports = {
    GMAIL_CONFIG_KEYS,
    buildPrioritySearchQueries,
    resolveGmailConfig,
    resolveGmailOAuthClientConfig,
    getGmailAuthUrl,
    exchangeGmailAuthCode,
    saveGmailRefreshToken,
    getClient,
    toMessage,
    SEARCH_QUERY,
    sendEmail,
    getProfileEmail
};
