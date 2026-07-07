const extractEmail = from =>
    String(from ?? "").match(/<([^>]+)>/)?.[1]?.toLowerCase()
    ?? String(from ?? "").trim().toLowerCase();

const toLines = text => String(text ?? "").trim().split("\n").map(line => line.trim()).filter(Boolean);

const commonSuffixLines = (bodies) => {
    const lineSets = bodies.map(toLines);
    if (lineSets.length < 2) return [];

    const suffix = [];
    for (let i = 1; ; i++) {
        const row = lineSets.map(lines => lines.at(-i));
        if (row.some(value => value === undefined)) break;
        if (new Set(row).size !== 1) break;
        suffix.unshift(row[0]);
    }
    return suffix;
};

const MIN_SIGNATURE_LINES = 2;
const MIN_SIGNATURE_CHARS = 24;

const isSignificantSuffix = lines =>
    lines.length >= MIN_SIGNATURE_LINES || lines.join("\n").length >= MIN_SIGNATURE_CHARS;

const stripSuffixFromBody = (body, suffixLines) => {
    if (!suffixLines.length) return { text: String(body ?? "").trim(), signature: "" };

    const lines = String(body ?? "").split("\n");
    let remaining = [...suffixLines];
    let cutFrom = lines.length;

    for (let i = lines.length - 1; i >= 0 && remaining.length; i--) {
        const line = lines[i].trim();
        if (!line) {
            cutFrom = i;
            continue;
        }
        if (line === remaining[remaining.length - 1]) {
            remaining.pop();
            cutFrom = i;
            continue;
        }
        break;
    }

    if (remaining.length) return { text: String(body ?? "").trim(), signature: "" };

    const text = lines.slice(0, cutFrom).join("\n").trimEnd();
    const signature = suffixLines.join("\n");
    return { text: text || String(body ?? "").trim(), signature };
};

const DELIMITER_SIGNATURE = /\n-- \n[\s\S]*$/;

const splitDelimiterSignature = (body) => {
    const text = String(body ?? "");
    const match = text.match(DELIMITER_SIGNATURE);
    if (!match) return null;

    const signature = match[0].replace(/^\n-- \n/, "").trim();
    if (!signature) return null;

    return { text: text.slice(0, match.index).trimEnd(), signature };
};

const buildSignatureSuffixBySender = (messages) => {
    const bySender = {};

    for (const message of messages ?? []) {
        const sender = extractEmail(message.from);
        if (!sender || !message.body) continue;
        if (!bySender[sender]) bySender[sender] = [];
        bySender[sender].push(message.body);
    }

    return Object.fromEntries(
        Object.entries(bySender)
            .map(([sender, bodies]) => {
                const suffix = commonSuffixLines(bodies);
                return isSignificantSuffix(suffix) ? [sender, suffix] : null;
            })
            .filter(Boolean)
    );
};

const splitMessageBody = (body, suffixBySender, from) => {
    const suffix = suffixBySender[extractEmail(from)];
    if (suffix?.length) {
        const split = stripSuffixFromBody(body, suffix);
        if (split.signature) return split;
    }

    return splitDelimiterSignature(body) ?? { text: String(body ?? "").trim(), signature: "" };
};

module.exports = {
    extractEmail,
    buildSignatureSuffixBySender,
    splitMessageBody,
};
