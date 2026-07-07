const { extractEmail } = require("./emailSignature");

// Section-weighting for carrier emails: outline the body into typed sections,
// anchor on the sender's signature (name/company), weight top-down with hard
// decay below the anchor, and stop once enough appointment facts are found.
// Nothing is deleted — dropped sections stay in `sections` for the UI to expand.

// ---------- tunables ----------

const ABOVE_TOP = 1;         // first content section above the anchor
const ABOVE_DECAY = 0.85;    // per content section moving down toward the anchor
const ABOVE_FLOOR = 0.6;
const GREETING_WEIGHT = 0.2;
const ANCHOR_WEIGHT = 0.35;  // the signature identifies the carrier but holds no facts
const BELOW_FIRST = 0.3;     // first section below the anchor
const BELOW_DECAY = 0.5;     // per section further below
const QUOTE_CAP = 0.2;       // quoted history may be our own words — never weight it as sender content
const FACT_BOOST = 0.3;
const KEEP_THRESHOLD = 0.3;
const CHAR_BUDGET = 1500;    // stop keeping sections once relevantText reaches this size

const GENERIC_DOMAINS = new Set(["gmail", "yahoo", "outlook", "hotmail", "aol", "icloud", "live", "msn", "mail", "comcast", "att", "verizon", "protonmail"]);

const QUOTE_HEADERS = [
    /^On (Mon|Tue|Wed|Thu|Fri|Sat|Sun|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|\d).{3,200} wrote:/i,
    / wrote:$/,
    /^-{2,}\s*(Original|Forwarded) Message\s*-{2,}/i,
    /^Begin forwarded message/i,
    /^_{10,}$/,
];
const HEADER_FIELD = /^(Sent|To|Subject|Date|Cc):\s/i;
const EMAIL_IN_LINE = /\S+@\S+\.\S+/;

const SIGN_OFF = /^(thanks|thank you|many thanks|thx|best|best regards|warm regards|regards|kind regards|sincerely|cheers|respectfully)\s*[,!.]*$/i;
const GREETING = /^(hi|hello|hey|dear|good (morning|afternoon|evening))\b[^,\n]{0,40}[,!.]*$/i;
const DISCLAIMER = /confidential|privileged|intended (recipient|solely)|do not (disseminate|distribute)|received this (e-?mail )?in error/i;
const FOOTER = /^sent from my |unsubscribe|view (this|it) in your browser/im;
const PHONE = /(\(\d{3}\)\s*\d{3}[-.\s]?\d{4})|(\b\d{3}[-.]\d{3}[-.]\d{4}\b)|(\+\d{1,2}[\s.-]?\d{3}[\s.-]?\d{3}[\s.-]?\d{4})/;
const URL = /(https?:\/\/|www\.)\S+/i;

const TIME_HINTS = [
    /\b\d{1,2}(:\d{2})?\s*(a\.?m\.?|p\.?m\.?)\b/i,
    /\b([01]?\d|2[0-3]):[0-5]\d\b/,
    /\b(at|by|for|around|after|before)\s+([01]\d|2[0-3])[0-5]\d\b/i,
    /\b(noon|midnight)\b/i,
];
const DATE_HINTS = [
    /\b(0?[1-9]|1[0-2])\/\d{1,2}(\/\d{2,4})?\b/,
    /\b(mon|tues?|wednes|thurs?|fri|satur|sun)day\b/i,
    /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*\d{1,2}\b/i,
    /\b(today|tomorrow|tonight)\b/i,
];
const INTENT_HINTS = [/\b(appointment|appt|pick\s?up|deliver|schedul|reschedul|confirm|eta|arriv)/i];
const FACT_HINTS = [...TIME_HINTS, ...DATE_HINTS, ...INTENT_HINTS];

// ---------- outline: segment into typed sections ----------

// Break inline quote markers onto their own lines so flattened HTML bodies still segment
const prepare = body => String(body ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/(-{2,}\s*(?:Original|Forwarded) Message\s*-{2,})/gi, "\n$1\n")
    .replace(/([^\n])[ \t]+(On (?:Mon|Tue|Wed|Thu|Fri|Sat|Sun|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|\d)[^\n]{3,160}? wrote:)/g, "$1\n$2\n");

// A "From:" line is only a forwarded header when it carries an email address
// or is followed by other header fields — "From: my side..." stays content.
const isQuoteHeader = (lines, index) => {
    const line = lines[index];
    if (QUOTE_HEADERS.some(pattern => pattern.test(line))) return true;
    if (!/^From:\s/i.test(line)) return false;
    if (EMAIL_IN_LINE.test(line)) return true;
    return lines.slice(index + 1, index + 4).some(next => HEADER_FIELD.test(next));
};

const groupSections = (lines) => {
    const groups = [];
    let current = null;
    const close = () => {
        if (current?.lines.length) groups.push(current);
        current = null;
    };

    lines.forEach((line, index) => {
        if (!line) return close();

        const quoted = line.startsWith(">");
        const header = isQuoteHeader(lines, index);
        const signoff = SIGN_OFF.test(line);

        if (header || signoff || (current && quoted !== current.quoted)) close();
        if (!current) current = { lines: [], quoted, header, signoff };
        current.lines.push(line);
    });

    close();
    return groups;
};

const looksLikeSignatureBlock = (lines) => {
    if (lines.length > 6 || !lines.every(line => line.length <= 60)) return false;
    if (!lines.some(line => PHONE.test(line) || URL.test(line) || EMAIL_IN_LINE.test(line))) return false;
    return !lines.some(line => FACT_HINTS.some(pattern => pattern.test(line)));
};

const classifySections = (groups, suffixLines) => {
    const suffixSet = new Set((suffixLines ?? []).map(line => line.trim()).filter(Boolean));
    let quoteMode = false;

    return groups.map((group, index) => {
        const text = group.lines.join("\n");

        if (group.quoted || group.header) {
            quoteMode = true;
            return { text, type: "quote" };
        }
        if (DISCLAIMER.test(text) && text.length >= 60) return { text, type: "disclaimer" };
        if (FOOTER.test(text)) return { text, type: "footer" };
        if (quoteMode) return { text, type: "quote" };

        const learned = suffixSet.size > 0 && group.lines.every(line => suffixSet.has(line));
        if (learned || group.signoff || (index > 0 && looksLikeSignatureBlock(group.lines))) return { text, type: "signature" };
        if (index === 0 && group.lines.length === 1 && GREETING.test(group.lines[0])) return { text, type: "greeting" };
        return { text, type: "content" };
    });
};

// ---------- anchor: sender name or company as the center point ----------

const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const containsWord = (text, word) => new RegExp(`\\b${escapeRegex(word)}\\b`, "i").test(text);

const senderHints = (from, scac) => {
    const email = extractEmail(from);
    const display = String(from ?? "").replace(/<[^>]+>/, "").replace(/"/g, "").trim();
    const hints = display.toLowerCase().split(/[^a-z0-9]+/).filter(token => token.length >= 3);

    const domainRoot = email.split("@")[1]?.split(".")[0] ?? "";
    if (domainRoot.length >= 3 && !GENERIC_DOMAINS.has(domainRoot)) hints.push(domainRoot);
    if (scac) hints.push(String(scac).toLowerCase());

    return [...new Set(hints.filter(Boolean))];
};

// -1 means no divider found: the whole email is fresh content (virtual anchor past the end)
const findAnchorIndex = (sections, hints) => {
    const signatureIndex = sections.findIndex(section => section.type === "signature");
    if (signatureIndex !== -1) return signatureIndex;

    // Skip the first content section — an intro like "this is Jeff from ARKA" is content, not the divider
    const firstContent = sections.findIndex(section => section.type === "content");
    const identityIndex = sections.findIndex((section, index) =>
        index !== firstContent
        && section.type === "content"
        && hints.some(hint => containsWord(section.text, hint)));
    if (identityIndex !== -1) return identityIndex;

    return sections.findIndex(section => section.type === "quote");
};

// ---------- facts ----------

const hasReference = (text, candidates) =>
    candidates.some(candidate =>
        (candidate.loadNumber && text.includes(candidate.loadNumber))
        || (candidate.proNumber && text.includes(candidate.proNumber)));

const hasTimeOrDate = text => TIME_HINTS.some(pattern => pattern.test(text)) || DATE_HINTS.some(pattern => pattern.test(text));

const hasFacts = (text, candidates) => hasReference(text, candidates) || FACT_HINTS.some(pattern => pattern.test(text));

// ---------- weigh + select ----------

// weighEmail(body, { from, candidates, scac, suffixBySender })
// -> { sections: [{ text, type, weight, kept }], relevantText, anchorIndex }
const weighEmail = (body, { from = "", candidates = [], scac = "", suffixBySender = {} } = {}) => {
    const suffixLines = suffixBySender[extractEmail(from)] ?? [];
    const groups = groupSections(prepare(body).split("\n").map(line => line.trim()));
    const sections = classifySections(groups, suffixLines);
    if (!sections.length) return { sections: [], relevantText: "", anchorIndex: -1 };

    const anchorIndex = findAnchorIndex(sections, senderHints(from, scac));

    let aboveContentRank = 0;
    const weighted = sections.map((section, index) => {
        const base = (() => {
            if (section.type === "disclaimer" || section.type === "footer") return 0;
            if (index === anchorIndex) return section.type === "quote" ? QUOTE_CAP : ANCHOR_WEIGHT;
            if (anchorIndex === -1 || index < anchorIndex) {
                if (section.type === "quote") return QUOTE_CAP;
                if (section.type === "greeting") return GREETING_WEIGHT;
                if (section.type === "signature") return ANCHOR_WEIGHT;
                return Math.max(ABOVE_FLOOR, ABOVE_TOP * ABOVE_DECAY ** aboveContentRank++);
            }
            const below = BELOW_FIRST * BELOW_DECAY ** (index - anchorIndex - 1);
            return section.type === "quote" ? Math.min(below, QUOTE_CAP) : below;
        })();

        const weight = base > 0 && section.type !== "quote" && hasFacts(section.text, candidates)
            ? Math.min(1, base + FACT_BOOST)
            : base;

        return { ...section, weight: Math.round(weight * 100) / 100 };
    });

    let haveReference = false;
    let haveTimeOrDate = false;
    let sufficient = false;
    let exhausted = false;
    let keptLength = 0;

    const finalSections = weighted.map((section) => {
        if (sufficient) return { ...section, weight: 0, kept: false };
        if (exhausted || section.weight < KEEP_THRESHOLD) return { ...section, kept: false };

        if (keptLength && keptLength + section.text.length > CHAR_BUDGET) {
            exhausted = true;
            return { ...section, kept: false };
        }

        keptLength += section.text.length;
        haveReference ||= hasReference(section.text, candidates);
        haveTimeOrDate ||= hasTimeOrDate(section.text);
        sufficient = haveReference && haveTimeOrDate;
        return { ...section, kept: true };
    });

    if (!finalSections.some(section => section.kept))
        finalSections[Math.max(finalSections.findIndex(section => section.type === "content"), 0)].kept = true;

    return {
        sections: finalSections,
        relevantText: finalSections.filter(section => section.kept).map(section => section.text).join("\n\n"),
        anchorIndex,
    };
};

module.exports = { weighEmail };
