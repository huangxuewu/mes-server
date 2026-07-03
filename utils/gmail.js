const { google } = require("googleapis");

// NOTE: Stage 1 uses hard-coded credentials (same pattern as passcodeCrypto.js).
// Run `node utils/gmailAuthSetup.js` once to obtain the refresh token.
const CLIENT_ID = "GOOGLE_CLIENT_ID";
const CLIENT_SECRET = "GOOGLE_CLIENT_SECRET";
const REFRESH_TOKEN = "GOOGLE_REFRESH_TOKEN";
const REDIRECT_URI = "https://dh-mes-backend-73abf9398712.herokuapp.com/oauth2callback";

const SEARCH_QUERY = "newer_than:14d -category:{promotions social}";

const getClient = () => {
    const auth = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
    auth.setCredentials({ refresh_token: REFRESH_TOKEN });
    return google.gmail({ version: "v1", auth });
};

const getHeader = (message, name) =>
    message.payload?.headers?.find(h => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";

const decodeBody = data => Buffer.from(data, "base64url").toString("utf8");

const findPart = (payload, mimeType) => {
    if (payload.mimeType === mimeType && payload.body?.data) return payload.body.data;
    for (const part of payload.parts ?? []) {
        const found = findPart(part, mimeType);
        if (found) return found;
    }
    return null;
};

const stripHtml = html => html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

// Cut quoted reply tails so the AI only reads the new content
const REPLY_MARKERS = [/^On .+ wrote:$/m, /^-{2,}\s*Original Message\s*-{2,}/mi, /^From:\s.+$/m, /^>+\s/m];

const extractBody = (message) => {
    const plain = findPart(message.payload, "text/plain");
    const html = plain ? null : findPart(message.payload, "text/html");
    let body = plain ? decodeBody(plain) : html ? stripHtml(decodeBody(html)) : message.snippet ?? "";

    for (const marker of REPLY_MARKERS) {
        const match = body.match(marker);
        if (match && match.index > 0) body = body.slice(0, match.index);
    }

    return body.trim().slice(0, 4000);
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

// Returns recent threads with parsed messages, excluding already-known message ids
const fetchThreads = async (knownMessageIds = new Set()) => {
    const gmail = getClient();
    const { data } = await gmail.users.threads.list({ userId: "me", q: SEARCH_QUERY, maxResults: 50 });
    if (!data.threads?.length) return [];

    const threads = await Promise.all(data.threads.map(async ({ id }) => {
        const { data: thread } = await gmail.users.threads.get({ userId: "me", id, format: "full" });
        const messages = (thread.messages ?? []).map(toMessage);
        return {
            threadId: thread.id,
            subject: messages[0]?.subject ?? "",
            messages,
            newMessages: messages.filter(m => !knownMessageIds.has(m.messageId)),
        };
    }));

    return threads.filter(t => t.newMessages.length);
};

const getProfileEmail = async () => {
    const gmail = getClient();
    const { data } = await gmail.users.getProfile({ userId: "me" });
    return data.emailAddress;
};

// Sends an email; pass threadId + inReplyTo to reply in-thread, omit both for a fresh email
const sendEmail = async ({ threadId, to, subject, body, inReplyTo }) => {
    const gmail = getClient();
    const from = await getProfileEmail();

    const headers = [
        `From: ${from}`,
        `To: ${to}`,
        `Subject: ${subject}`,
        "Content-Type: text/plain; charset=utf-8",
    ];
    if (inReplyTo) headers.push(`In-Reply-To: ${inReplyTo}`, `References: ${inReplyTo}`);

    const raw = Buffer.from(`${headers.join("\r\n")}\r\n\r\n${body}`).toString("base64url");
    const { data } = await gmail.users.messages.send({
        userId: "me",
        requestBody: { raw, ...(threadId ? { threadId } : {}) },
    });

    const { data: sent } = await gmail.users.messages.get({ userId: "me", id: data.id, format: "full" });
    return toMessage(sent);
};

module.exports = { fetchThreads, sendEmail, getProfileEmail };
