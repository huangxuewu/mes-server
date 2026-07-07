const { extractEmail } = require("./emailSignature");

// Section-weighting for carrier emails: outline the body into typed sections,
// anchor on the sender's signature (name/company) — or on the load/PRO
// reference for sender-less machine emails — weight top-down with hard decay
// below the anchor, and stop once enough appointment facts are found.
// Nothing is deleted — dropped sections stay in `sections` for the UI to expand.

// ---------- tunables ----------

const ABOVE_TOP = 1;           // first content section above the anchor
const ABOVE_DECAY = 0.85;      // per content section moving down toward the anchor
const ABOVE_FLOOR = 0.6;
const GREETING_WEIGHT = 0.2;
const ANCHOR_WEIGHT = 0.35;    // the signature identifies the carrier but holds no facts
const BELOW_FIRST = 0.3;       // first section below the anchor
const BELOW_DECAY = 0.5;       // per section further below
const QUOTE_CAP = 0.2;         // quoted history may be our own words — never weight it as sender content
const REFERENCE_DECAY = 0.7;   // machine emails: outward decay from the load/PRO reference anchor
const KEEP_THRESHOLD = 0.3;
const CHAR_BUDGET = 1500;      // stop keeping sections once relevantText reaches this size

// Carrier-appointment info gets extra attention: boosts stack (cap 1.0) on content sections
const REFERENCE_BOOST = 0.3;   // candidate load / PRO number
const TIME_DATE_BOOST = 0.2;   // a stated time or date
const INTENT_BOOST = 0.15;     // trucking / appointment vocabulary

// Long runs without spaces (emails, URLs, phone strings) are signature/footer-ish, not prose
const LONG_TOKEN = /\S{20,}/;
const UNSPACED_THRESHOLD = 0.4;
const UNSPACED_PENALTY = 0.3;

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

const SIGN_OFF = /^(thanks|thank you|many thanks|thx|thanks?\s*(and|&)\s*regards|best|(with )?(kind|best|warm) regards|regards|sincerely|cheers|respectfully|take care)\s*[,!.]*$/i;
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
const INTENT_HINTS = [/\b(appointment|appt|pick\s?up|drop\s?off|deliver|schedul|reschedul|confirm|eta|arriv|dispatch|driver|trailer|truck|dock|door|check[\s-]?in|bol|pallet|shipment|freight|carrier|warehouse|tender|window|slot|detention|delay)/i];

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

const isContactLine = line => PHONE.test(line) || URL.test(line) || EMAIL_IN_LINE.test(line) || LONG_TOKEN.test(line);

// Signature lines carry few spaces (name / title / company / phone); prose has many words.
// Only hard facts (time/date/reference) disqualify — company names like "ARKA Freight"
// legitimately contain trucking vocabulary and must stay signature.
const isShortWorded = line => line.split(/\s+/).length <= 6;

const isSignatureShaped = (lines, candidates) =>
    lines.length <= 6
    && lines.every(line => line.length <= 60 && isShortWorded(line))
    && !lines.some(line => hasTimeOrDate(line) || hasReference(line, candidates));

const looksLikeSignatureBlock = (lines, candidates) =>
    isSignatureShaped(lines, candidates) && lines.some(isContactLine);

const classifySections = (groups, suffixLines, candidates) => {
    const suffixSet = new Set((suffixLines ?? []).map(line => line.trim()).filter(Boolean));
    let quoteMode = false;
    let signatureMode = false;

    return groups.map((group, index) => {
        const text = group.lines.join("\n");

        if (group.quoted || group.header) {
            quoteMode = true;
            return { text, type: "quote" };
        }
        if (DISCLAIMER.test(text) && text.length >= 60) return { text, type: "disclaimer" };
        if (FOOTER.test(text)) return { text, type: "footer" };
        if (quoteMode) return { text, type: "quote" };

        // After a sign-off, short fact-free blocks (name / title / company) are still the signature
        const learned = suffixSet.size > 0 && group.lines.every(line => suffixSet.has(line));
        const continuation = signatureMode && isSignatureShaped(group.lines, candidates);
        if (learned || group.signoff || continuation || (index > 0 && looksLikeSignatureBlock(group.lines, candidates))) {
            signatureMode = true;
            return { text, type: "signature" };
        }
        if (index === 0 && group.lines.length === 1 && GREETING.test(group.lines[0])) return { text, type: "greeting" };
        return { text, type: "content" };
    });
};

// ---------- anchor: sender name / company — or the reference for machine emails ----------

const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const containsWord = (text, word) => new RegExp(`\\b${escapeRegex(word)}\\b`, "i").test(text);

// A From header without a display name ("noreply@tms.com") is software-generated
const hasSenderName = (from) => {
    const display = String(from ?? "").replace(/<[^>]+>/, "").replace(/"/g, "").trim();
    return Boolean(display) && !display.includes("@");
};

const senderHints = (from, scac) => {
    const email = extractEmail(from);
    const display = String(from ?? "").replace(/<[^>]+>/, "").replace(/"/g, "").trim();
    const hints = display.toLowerCase().split(/[^a-z0-9]+/).filter(token => token.length >= 3);

    const domainRoot = email.split("@")[1]?.split(".")[0] ?? "";
    if (domainRoot.length >= 3 && !GENERIC_DOMAINS.has(domainRoot)) hints.push(domainRoot);
    if (scac) hints.push(String(scac).toLowerCase());

    return [...new Set(hints.filter(Boolean))];
};

// index -1 means no divider found: the whole email is fresh content (virtual anchor past the end)
const findAnchor = (sections, hints, candidates, machine) => {
    if (machine) {
        const referenceIndex = sections.findIndex(section =>
            section.type !== "quote" && section.type !== "disclaimer" && section.type !== "footer"
            && hasReference(section.text, candidates));
        if (referenceIndex !== -1) return { index: referenceIndex, kind: "reference" };
    }

    const signatureIndex = sections.findIndex(section => section.type === "signature");
    if (signatureIndex !== -1) return { index: signatureIndex, kind: "standard" };

    // Skip the first content section — an intro like "this is Jeff from ARKA" is content, not the divider
    const firstContent = sections.findIndex(section => section.type === "content");
    const identityIndex = sections.findIndex((section, index) =>
        index !== firstContent
        && section.type === "content"
        && hints.some(hint => containsWord(section.text, hint)));
    if (identityIndex !== -1) return { index: identityIndex, kind: "standard" };

    return { index: sections.findIndex(section => section.type === "quote"), kind: "standard" };
};

// ---------- facts ----------

const hasReference = (text, candidates) =>
    candidates.some(candidate =>
        (candidate.loadNumber && text.includes(candidate.loadNumber))
        || (candidate.proNumber && text.includes(candidate.proNumber)));

const hasTimeOrDate = text => TIME_HINTS.some(pattern => pattern.test(text)) || DATE_HINTS.some(pattern => pattern.test(text));

const hasIntent = text => INTENT_HINTS.some(pattern => pattern.test(text));

// Share of characters living in long unbroken runs — high means links/ids, not prose
const unspacedRatio = (text) => {
    const compact = text.replace(/\s+/g, "");
    if (!compact) return 0;
    const longChars = text.split(/\s+/).filter(token => LONG_TOKEN.test(token)).join("").length;
    return longChars / compact.length;
};

// ---------- weigh + select ----------

// weighEmail(body, { from, candidates, scac, suffixBySender })
// -> { sections: [{ text, type, weight, kept }], relevantText, anchorIndex }
const weighEmail = (body, { from = "", candidates = [], scac = "", suffixBySender = {} } = {}) => {
    const suffixLines = suffixBySender[extractEmail(from)] ?? [];
    const groups = groupSections(prepare(body).split("\n").map(line => line.trim()));
    const sections = classifySections(groups, suffixLines, candidates);
    if (!sections.length) return { sections: [], relevantText: "", anchorIndex: -1 };

    const anchor = findAnchor(sections, senderHints(from, scac), candidates, !hasSenderName(from));

    let aboveContentRank = 0;
    const weighted = sections.map((section, index) => {
        const base = (() => {
            if (section.type === "disclaimer" || section.type === "footer") return 0;

            // Machine email: the reference is the center point, weight decays outward
            if (anchor.kind === "reference") {
                if (index === anchor.index) return 1;
                const decayed = REFERENCE_DECAY ** Math.abs(index - anchor.index);
                if (section.type === "quote") return Math.min(decayed, QUOTE_CAP);
                if (section.type === "greeting") return Math.min(decayed, GREETING_WEIGHT);
                if (section.type === "signature") return Math.min(decayed, ANCHOR_WEIGHT);
                return decayed;
            }

            if (index === anchor.index) return section.type === "quote" ? QUOTE_CAP : ANCHOR_WEIGHT;
            if (anchor.index === -1 || index < anchor.index) {
                if (section.type === "quote") return QUOTE_CAP;
                if (section.type === "greeting") return GREETING_WEIGHT;
                if (section.type === "signature") return ANCHOR_WEIGHT;
                return Math.max(ABOVE_FLOOR, ABOVE_TOP * ABOVE_DECAY ** aboveContentRank++);
            }
            const below = BELOW_FIRST * BELOW_DECAY ** (index - anchor.index - 1);
            return section.type === "quote" ? Math.min(below, QUOTE_CAP) : below;
        })();

        const reference = hasReference(section.text, candidates);
        const damped = base > 0 && !reference && unspacedRatio(section.text) > UNSPACED_THRESHOLD
            ? base * UNSPACED_PENALTY
            : base;

        // Appointment facts stack only on real prose — signatures/quotes stay capped
        const boostable = damped > 0 && (section.type === "content" || section.type === "greeting");
        const weight = boostable
            ? Math.min(1, damped
                + (reference ? REFERENCE_BOOST : 0)
                + (hasTimeOrDate(section.text) ? TIME_DATE_BOOST : 0)
                + (hasIntent(section.text) ? INTENT_BOOST : 0))
            : damped;

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
        anchorIndex: anchor.index,
    };
};

module.exports = { weighEmail };
