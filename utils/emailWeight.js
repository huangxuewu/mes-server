// Section-weighting for carrier emails: outline the body into typed sections,
// anchor on the sender's signature (name/company) — or on the load/PRO
// reference for sender-less machine emails — weight top-down with hard decay
// below the anchor, and stop once enough appointment facts are found.
// Nothing is deleted — dropped sections stay in `sections` for the UI to expand.
// CommonJS mirror of client/src/renderer/src/utils/emailWeight.js — keep both in sync.

// ---------- tunables ----------

const ABOVE_TOP = 1;           // first content section above the anchor
const ABOVE_DECAY = 0.85;      // per content section moving down toward the anchor
const ABOVE_FLOOR = 0.6;
const GREETING_WEIGHT = 0.2;
const ANCHOR_WEIGHT = 0.25;    // signature identifies sender but should not usually be extracted as facts
const BELOW_FIRST = 0.3;       // first content section below the anchor
const BELOW_DECAY = 0.5;       // per content section further below
const QUOTE_CAP = 0.2;         // quoted history may be our own words — never weight it as sender content
const REFERENCE_DECAY = 0.7;   // machine emails: outward decay from the load/PRO reference anchor
const KEEP_THRESHOLD = 0.3;
const CHAR_BUDGET = 1500;      // stop keeping sections once relevantText reaches this size

// Carrier-appointment info gets extra attention: boosts stack (cap 1.0) on content sections
const REFERENCE_BOOST = 0.3;   // candidate load / PRO / BOL / PO number
const TIME_DATE_BOOST = 0.2;   // a stated time or date
const INTENT_BOOST = 0.15;     // trucking / appointment vocabulary

// Long runs without spaces (emails, URLs, phone strings) are signature/footer-ish, not prose
const LONG_TOKEN = /\S{20,}/;
const UNSPACED_THRESHOLD = 0.4;
const UNSPACED_PENALTY = 0.3;

// Pure numeric references shorter than this are too easy to confuse with dates/times.
// If your carriers use 4-digit load numbers, require a nearby label before accepting them.
const MIN_NORMALIZED_REFERENCE_LENGTH = 5;

const GENERIC_DOMAINS = new Set(['gmail', 'yahoo', 'outlook', 'hotmail', 'aol', 'icloud', 'live', 'msn', 'mail', 'comcast', 'att', 'verizon', 'protonmail']);
const REFERENCE_KEYS = ['loadNumber', 'proNumber', 'bolNumber', 'poNumber', 'pickupNumber', 'shipmentNumber', 'referenceNumber', 'appointmentNumber', 'orderNumber'];

const QUOTE_HEADERS = [
    /^On (Mon|Tue|Wed|Thu|Fri|Sat|Sun|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|\d).{3,200} wrote:/i,
    / wrote:$/,
    /^-{2,}\s*(Original|Forwarded) Message\s*-{2,}/i,
    /^Begin forwarded message/i,
    /^_{10,}$/,
];
const QUOTE_ON_DATE = /^On (Mon|Tue|Wed|Thu|Fri|Sat|Sun|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|\d)/i;
const QUOTE_AT_TIME = /\s+at\s+\d{1,2}(:\d{2})?(?:[\s\u202f]+(AM|PM|am|pm|a\.m\.|p\.m\.))?/i;
const HEADER_FIELD = /^(From|Sent|To|Subject|Date|Cc|Bcc|Reply-To):\s/i;
const EMAIL_IN_LINE = /\S+@\S+\.\S+/;

const SIGN_OFF = /^(thanks|thank you|many thanks|thx|thanks?\s*(and|&)\s*regards|best|(with )?(kind|best|warm) regards|regards|sincerely|cheers|respectfully|take care)\s*[,!.]*$/i;
const SIGN_OFF_SHORT = /^(thanks?|best|regards|sincerely|cheers|respectfully)\s*[,!.]*$/i;
const TITLE_HINTS = /\b(manager|director|coordinator|specialist|supervisor|dispatcher|representative|rep|analyst|assistant|associate|lead|clerk|agent|executive|officer|president|vp|head|captain|planner)\b/i;
const GREETING = /^(hi|hello|hey|dear|good (morning|afternoon|evening))\b[^,\n]{0,40}[,!.]*$/i;
const DISCLAIMER = /confidential|privileged|intended (recipient|solely)|do not (disseminate|distribute)|received this (e-?mail )?in error/i;
const FOOTER = /^sent from my |unsubscribe|view (this|it) in your browser/im;
const PHONE = /(\(\d{3}\)\s*\d{3}[-.\s]?\d{4})|(\b\d{3}[-.]\d{3}[-.]\d{4}\b)|(\+\d{1,2}[\s.-]?\d{3}[\s.-]?\d{3}[\s.-]?\d{4})/;
const URL = /(https?:\/\/|www\.)\S+/i;
const EMBEDDED_CID = /\[cid:[^\]]+\]/i;

const TIME_HINTS = [
    /\b\d{1,2}(:\d{2})?\s*(a\.?m\.?|p\.?m\.?)\b/i,
    /\b([01]?\d|2[0-3]):[0-5]\d\b/,
    /\b(at|by|for|around|after|before)\s+([01]\d|2[0-3])[0-5]\d\b/i,
    /\b(noon|midnight)\b/i,
    /\b(?:between|from)\s+\d{1,2}(:\d{2})?\s*(a\.?m\.?|p\.?m\.?)?\s*(?:and|to|-|–)\s*\d{1,2}(:\d{2})?\s*(a\.?m\.?|p\.?m\.?)\b/i,
    /\b\d{1,2}(:\d{2})?\s*(a\.?m\.?|p\.?m\.?)?\s*[-–]\s*\d{1,2}(:\d{2})?\s*(a\.?m\.?|p\.?m\.?)\b/i,
    /\b(appointment|appt|pickup|pick\s?up|delivery|deliver|eta|arriv(?:e|al|ing)?|window|dock|door)\b.{0,40}\b\d{1,2}(:\d{2})?\s*(a\.?m\.?|p\.?m\.?)?\b/i,
];
const DATE_HINTS = [
    /\b\d{4}[-/]\d{1,2}[-/]\d{1,2}\b/,
    /\b(0?[1-9]|1[0-2])[-/]\d{1,2}([-/]\d{2,4})?\b/,
    /\b(mon|tues?|wednes|thurs?|fri|satur|sun)day\b/i,
    /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s*\d{1,2}(st|nd|rd|th)?\b/i,
    /\b\d{1,2}(st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\b/i,
    /\b(this|next)\s+(mon|tues?|wednes|thurs?|fri|satur|sun)day\b/i,
    /\b(today|tomorrow|tonight|eod)\b/i,
];
const INTENT_HINTS = [/\b(appointment|appt|pick\s?up|drop\s?off|deliver|delivery|schedul|reschedul|confirm|eta|arriv|dispatch|driver|trailer|truck|dock|door|check[\s-]?in|bol|pallet|shipment|freight|carrier|warehouse|tender|window|slot|detention|delay|load|pro|receiving|lumper)/i];
const RESCHEDULE_HINTS = /\b(reschedul|re-?schedul|postpone|push\s+back|move\s+(the\s+)?(pickup|appointment|time|window)|change\s+(the\s+)?(pickup|appointment|time|window))\b/i;
const QUESTION_HINTS = /\?|\b(can you|could you|would you|please confirm|what time|when can|when will|any update|let me know|do you have)\b/i;
const OUTGOING_REST_WEIGHT = 0.2;

const extractEmail = from =>
    String(from ?? '').match(/<([^>]+)>/)?.[1]?.toLowerCase()
    ?? String(from ?? '').trim().toLowerCase();

// ---------- facts ----------

const normalizeReference = value => String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

const candidateReferences = candidates => [...new Map(
    (candidates ?? [])
        .flatMap(candidate => REFERENCE_KEYS.map(key => candidate?.[key]))
        .filter(value => value !== undefined && value !== null && String(value).trim())
        .map(value => {
            const raw = String(value).trim();
            return [normalizeReference(raw), { raw, normalized: normalizeReference(raw) }];
        })
        .filter(([normalized]) => normalized.length >= MIN_NORMALIZED_REFERENCE_LENGTH)
).values()];

const createFactDetector = candidates => {
    const references = candidateReferences(candidates);

    const hasReference = text => {
        if (!references.length) return false;
        const rawText = String(text ?? '').toLowerCase();
        const normalizedText = normalizeReference(text);

        return references.some(reference => {
            // Exact raw match catches references containing separators, e.g. "123-456".
            if (reference.raw.length >= MIN_NORMALIZED_REFERENCE_LENGTH && rawText.includes(reference.raw.toLowerCase())) return true;

            // Normalized match catches carrier formatting changes, e.g. candidate "123456" vs "PRO #123-456".
            return normalizedText.includes(reference.normalized);
        });
    };

    const hasTime = text => TIME_HINTS.some(pattern => pattern.test(text));
    const hasDate = text => DATE_HINTS.some(pattern => pattern.test(text));
    const hasTimeOrDate = text => hasTime(text) || hasDate(text);
    const hasIntent = text => INTENT_HINTS.some(pattern => pattern.test(text));
    const facts = text => ({
        reference: hasReference(text),
        time: hasTime(text),
        date: hasDate(text),
        timeOrDate: hasTimeOrDate(text),
        intent: hasIntent(text),
    });

    return { references, hasReference, hasTime, hasDate, hasTimeOrDate, hasIntent, facts };
};

const hasSubstantiveOutgoingContent = (detector, text) => {
    const facts = detector.facts(text);
    return facts.reference
        || facts.timeOrDate
        || RESCHEDULE_HINTS.test(text)
        || QUESTION_HINTS.test(text);
};

const firstSentence = (text) => {
    const trimmed = String(text ?? '').trim();
    const match = trimmed.match(/^[^.!?\n]+(?:[.!?]+|$)/);
    return match?.[0]?.trim() || trimmed.split('\n')[0]?.trim() || trimmed;
};

const cleanLine = line => String(line ?? '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g, '-')
    .trim();

const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const parseSenderName = (from) => {
    const display = String(from ?? '').replace(/<[^>]+>/, '').replace(/"/g, '').trim();
    if (!display || display.includes('@')) return null;
    const parts = display.split(/\s+/).filter(Boolean);
    if (!parts.length) return null;
    return { full: display, first: parts[0], last: parts[parts.length - 1], parts };
};

const lineContainsSenderName = (line, sender) => {
    if (!sender) return false;
    const trimmed = cleanLine(line);
    if (!trimmed) return false;
    const full = new RegExp(`\\b${escapeRegex(sender.first)}\\s+${escapeRegex(sender.last)}\\b`, 'i');
    if (full.test(trimmed)) return true;
    return new RegExp(`\\b${escapeRegex(sender.first)}\\s+${escapeRegex(sender.last)}[-–]`, 'i').test(trimmed);
};

const isSignOffLine = (line) => {
    const trimmed = cleanLine(line);
    if (!trimmed) return false;
    if (SIGN_OFF.test(trimmed)) return true;
    const words = trimmed.split(/\s+/).filter(Boolean);
    return words.length <= 3 && SIGN_OFF_SHORT.test(trimmed);
};

const looksLikeAddressLine = (line) => {
    const trimmed = cleanLine(line);
    if (!trimmed) return false;
    if (/\bP\.?\s*O\.?\s*Box\b/i.test(trimmed)) return true;
    return /\b[A-Z]{2}\s+\d{5}(-\d{4})?\b/.test(trimmed) && /\d/.test(trimmed);
};

// ---------- outline: segment into typed sections ----------

// Break inline quote markers onto their own lines so flattened HTML bodies still segment.
// Also turns simple <br> boundaries into newlines when Gmail/HTML text has been lightly flattened.
const prepare = body => String(body ?? '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/\r\n?/g, '\n')
    .replace(/(-{2,}\s*(?:Original|Forwarded) Message\s*-{2,})/gi, '\n$1\n')
    .replace(/([^\n])[ \t]+(On (?:Mon|Tue|Wed|Thu|Fri|Sat|Sun|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec|\d)[^\n]{3,160}? wrote:)/g, '$1\n$2\n');

// A "From:" line is only a forwarded header when it carries an email address
// or is followed by other header fields — "From: my side..." stays content.
const isQuoteHeaderLine = (line) => {
    if (QUOTE_HEADERS.some(pattern => pattern.test(line))) return true;
    if (!QUOTE_ON_DATE.test(line)) return false;
    return QUOTE_AT_TIME.test(line) || / wrote:/i.test(line) || /<\s*$/.test(line) || /<\w/.test(line);
};

const isQuoteHeader = (lines, index) => {
    const line = lines[index];
    if (isQuoteHeaderLine(line)) return true;
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

        const quoted = line.startsWith('>');
        const header = isQuoteHeader(lines, index);
        const signoff = isSignOffLine(line);

        if (header || signoff || (current && quoted !== current.quoted)) close();
        if (!current) current = { lines: [], quoted, header, signoff };
        current.lines.push(line);
    });

    close();
    return groups;
};

const isContactLine = line => PHONE.test(cleanLine(line)) || EMAIL_IN_LINE.test(line) || LONG_TOKEN.test(line) || /<tel:/i.test(line) || /<mailto:/i.test(line);
const isLinkLine = line => URL.test(cleanLine(line));
const isGibberishLine = line => EMBEDDED_CID.test(cleanLine(line));
const isShortWorded = line => cleanLine(line).split(/\s+/).filter(Boolean).length <= 6;

const looksLikeJobTitle = (line) => {
    const trimmed = cleanLine(line);
    if (!trimmed || !isShortWorded(trimmed) || looksLikeAddressLine(trimmed)) return false;
    if (TITLE_HINTS.test(trimmed)) return true;
    return trimmed.split(/\s+/).filter(Boolean).length >= 3;
};

const looksLikePersonName = (line) => {
    const trimmed = cleanLine(line);
    if (!trimmed || trimmed === '|') return false;
    const words = trimmed.split(/\s+/).filter(Boolean);
    if (words.length < 2 || words.length > 5) return false;
    if (PHONE.test(trimmed) || EMAIL_IN_LINE.test(trimmed) || URL.test(trimmed)) return false;
    if (isSignOffLine(trimmed) || looksLikeAddressLine(trimmed) || looksLikeJobTitle(trimmed)) return false;
    return words.every(word => /^[A-Z][A-Za-z'-]+$/.test(word) || /^[A-Z]\.$/.test(word));
};

const splitNameTitleHyphen = (line, sender) => {
    const trimmed = cleanLine(line);
    const match = trimmed.match(/^(.+?)[-–](.+)$/);
    if (!match) return null;
    const name = match[1].trim();
    const title = match[2].trim();
    if (!name || !title) return null;
    if (sender && !lineContainsSenderName(trimmed, sender) && !lineContainsSenderName(name, sender)) return null;
    if (!sender && !looksLikePersonName(name)) return null;
    if (!looksLikeJobTitle(title) && !TITLE_HINTS.test(title)) return null;
    return { name, title };
};

const expandClosingInputLines = (lines, sender) =>
    lines.flatMap((line) => {
        const split = splitNameTitleHyphen(line, sender);
        return split ? [split.name, split.title] : [line];
    });

const findSenderClosingStart = (lines, sender) => {
    if (!sender) return null;
    const cleaned = lines.map(cleanLine);
    let nameLineIndex = -1;

    for (let i = cleaned.length - 1; i >= 0; i--) {
        if (isQuoteHeaderLine(cleaned[i]) || isQuoteHeader(lines, i) || /^From:\s/i.test(cleaned[i])) continue;
        if (lineContainsSenderName(cleaned[i], sender) || splitNameTitleHyphen(cleaned[i], sender)) {
            nameLineIndex = i;
            break;
        }
    }

    if (nameLineIndex === -1) return null;

    let start = nameLineIndex;
    while (start > 0 && isSignOffLine(cleaned[start - 1])) start--;

    let end = lines.length;
    for (let i = start; i < lines.length; i++) {
        if (isQuoteHeaderLine(cleaned[i]) || isQuoteHeader(lines, i)) {
            end = i;
            break;
        }
    }

    if (start >= end) return null;

    return { start, end, nameLineIndex };
};

const anchorGroupsBySender = (lines, from) => {
    const sender = parseSenderName(from);
    if (!sender) return null;

    const anchor = findSenderClosingStart(lines, sender);
    if (!anchor) return null;

    const closingLines = expandClosingInputLines(lines.slice(anchor.start, anchor.end), sender);
    const bodyGroups = groupSections(lines.slice(0, anchor.start));
    if (!closingLines.length) return bodyGroups.length ? bodyGroups : null;

    return [
        ...bodyGroups,
        {
            lines: closingLines,
            quoted: false,
            header: false,
            signoff: closingLines.some(isSignOffLine),
            inlineSignature: true,
            senderAnchored: true,
        },
    ];
};

const closingLinesCleaned = lines =>
    lines.map(cleanLine).filter(line => line && line !== '|');

const looksLikeClosingBlock = (lines, detector) => {
    const cleaned = closingLinesCleaned(lines);
    if (cleaned.length < 2) return false;
    if (cleaned.some(line => detector.hasTimeOrDate(line) || detector.hasReference(line))) return false;

    const nameLines = cleaned.filter(looksLikePersonName);
    if (nameLines.length !== 1) return false;

    const nameIndex = cleaned.findIndex(looksLikePersonName);
    const afterName = cleaned.slice(nameIndex + 1);
    const titleLines = afterName.filter(looksLikeJobTitle);
    if (titleLines.length > 1) return false;

    const hasTitle = titleLines.length === 1;
    const hasAddress = afterName.some(looksLikeAddressLine);

    if (hasTitle && (hasAddress || afterName.length >= 1)) return true;
    if (hasAddress && cleaned.length - nameIndex >= 3) return true;
    if (afterName.length >= 1 && !afterName.some(looksLikePersonName) && afterName.every(line => isShortWorded(line) && line.length <= 50))
        return true;
    return looksLikeSignatureBlock(cleaned, detector);
};

const isSignatureShaped = (lines, detector) => {
    const cleaned = closingLinesCleaned(lines);
    return cleaned.length <= 6
        && cleaned.every(line => line.length <= 60 && isShortWorded(line))
        && !cleaned.some(line => detector.hasTimeOrDate(line) || detector.hasReference(line));
};

const looksLikeSignatureBlock = (lines, detector) =>
    isSignatureShaped(lines, detector) && closingLinesCleaned(lines).some(isContactLine);

const isClosingShaped = (lines, detector) => {
    const cleaned = closingLinesCleaned(lines);
    if (!cleaned.length || cleaned.length > 8) return false;
    if (cleaned.some(line => detector.hasTimeOrDate(line) || detector.hasReference(line))) return false;
    if (cleaned.filter(looksLikePersonName).length > 1) return false;
    if (looksLikeClosingBlock(cleaned, detector)) return true;
    if (cleaned.length < 2) return false;
    return isSignatureShaped(cleaned, detector);
};

const splitContentAndClosing = (lines, detector) => {
    for (let start = 1; start < lines.length; start++) {
        const tail = lines.slice(start);
        if (!looksLikeClosingBlock(tail, detector)) continue;
        return { body: lines.slice(0, start), signature: tail };
    }
    return null;
};

const splitGroupContentClosing = (group, detector) => {
    if (group.quoted || group.header) return [group];
    const split = splitContentAndClosing(group.lines, detector);
    if (!split) return [group];

    const chunks = [];
    if (split.body.length) chunks.push({ ...group, lines: split.body });
    if (split.signature.length) chunks.push({
        lines: split.signature,
        quoted: false,
        header: false,
        signoff: split.signature.some(line => isSignOffLine(line)),
        inlineSignature: true,
    });
    return chunks;
};

const expandGroupsForClosing = (groups, detector) =>
    groups.flatMap(group => splitGroupContentClosing(group, detector));

const isSignatureCandidateLine = (line, detector, suffixSet) => {
    const trimmed = cleanLine(line);
    if (!trimmed || trimmed === '|') return false;
    if (suffixSet.has(trimmed)) return true;
    if (isSignOffLine(trimmed)) return true;
    if (looksLikeAddressLine(trimmed)) return true;
    if (isLinkLine(trimmed) || isGibberishLine(trimmed)) return true;
    if (looksLikePersonName(trimmed)) return true;
    if (TITLE_HINTS.test(trimmed) && isShortWorded(trimmed)) return true;
    if (trimmed.length > 80 || !isShortWorded(trimmed)) return false;
    if (detector.hasTimeOrDate(trimmed) || detector.hasReference(trimmed)) return false;
    return true;
};

const peelTrailingSignature = (lines, detector, suffixSet, suffixLines) => {
    if (lines.length < 2) return { body: lines, signature: [] };

    const trimmed = lines.map(line => line.trim());
    if (suffixLines?.length) {
        for (let start = trimmed.length - suffixLines.length; start >= 0; start--) {
            const tail = trimmed.slice(start, start + suffixLines.length);
            if (!suffixLines.every((line, index) => tail[index] === line)) continue;
            if (!start) return { body: [], signature: lines };
            return { body: lines.slice(0, start), signature: lines.slice(start) };
        }
    }

    let peelFrom = lines.length;
    while (peelFrom > 1 && isSignatureCandidateLine(lines[peelFrom - 1], detector, suffixSet)) peelFrom--;

    let body = lines.slice(0, peelFrom);
    let signature = lines.slice(peelFrom);
    while (body.length && isSignOffLine(body[body.length - 1].trim()))
        signature.unshift(body.pop());

    if (!signature.length || !body.length) return { body: lines, signature: [] };

    const hasSuffix = signature.some(line => suffixSet.has(cleanLine(line)));
    const hasContact = signature.some(isContactLine);
    const closingTail = looksLikeClosingBlock(signature, detector);
    if (!(hasSuffix || hasContact || signature.some(line => isSignOffLine(line)) || closingTail))
        return { body: lines, signature: [] };

    return { body, signature };
};

const splitGroupsForInlineSignatures = (groups, detector, suffixLines) => {
    const suffixSet = new Set((suffixLines ?? []).map(line => cleanLine(line)).filter(Boolean));

    return expandGroupsForClosing(groups, detector).flatMap((group) => {
        if (group.quoted || group.header || group.inlineSignature) return [group];

        const { body, signature } = peelTrailingSignature(group.lines, detector, suffixSet, suffixLines);
        if (!signature.length) return [group];
        if (!body.length) return [{ lines: signature, quoted: false, header: false, signoff: signature.some(isSignOffLine), inlineSignature: true }];

        const chunks = [];
        if (body.length) chunks.push({ ...group, lines: body, signoff: body.some(isSignOffLine) });
        chunks.push({
            lines: signature,
            quoted: false,
            header: false,
            signoff: signature.some(isSignOffLine),
            inlineSignature: true,
        });
        return chunks;
    });
};

const classifyClosingLine = (line, state, sender) => {
    const trimmed = cleanLine(line);
    if (!trimmed || trimmed === '|') return null;
    if (isSignOffLine(trimmed)) return { text: trimmed, role: 'signoff', next: { ...state, seenSignoff: true } };
    if (isLinkLine(trimmed)) return { text: trimmed, role: 'link', next: state };
    if (isGibberishLine(trimmed)) return { text: trimmed, role: 'gibberish', next: state };
    if (isContactLine(trimmed)) return { text: trimmed, role: 'contact', next: state };
    if (!state.seenName && sender && lineContainsSenderName(trimmed, sender))
        return { text: trimmed, role: 'name', next: { ...state, seenName: true } };
    if (!state.seenName && looksLikePersonName(trimmed)) return { text: trimmed, role: 'name', next: { ...state, seenName: true } };
    if (state.seenSignoff && !state.seenName && (lineContainsSenderName(trimmed, sender) || looksLikePersonName(trimmed)))
        return { text: trimmed, role: 'name', next: { ...state, seenName: true } };
    if (state.seenName && looksLikeAddressLine(trimmed)) return { text: trimmed, role: 'address', next: state };
    if (state.seenName && !state.seenTitle && looksLikeJobTitle(trimmed))
        return { text: trimmed, role: 'title', next: { ...state, seenTitle: true } };
    if (state.seenName && isShortWorded(trimmed) && trimmed.length <= 50)
        return { text: trimmed, role: 'company', next: state };
    if (!state.seenSignoff && isShortWorded(trimmed) && trimmed.split(/\s+/).filter(Boolean).length <= 3)
        return { text: trimmed, role: 'signoff', next: { ...state, seenSignoff: true } };
    return { text: trimmed, role: 'gibberish', next: state };
};

const consolidateClosingSections = (sections, sender) => {
    const result = [];
    let index = 0;

    while (index < sections.length) {
        if (sections[index].type !== 'signature') {
            result.push(sections[index]);
            index++;
            continue;
        }

        const closingLines = [];
        let state = { seenSignoff: false, seenName: false, seenTitle: false };
        while (index < sections.length && sections[index].type === 'signature') {
            for (const line of sections[index].text.split('\n').map(value => cleanLine(value)).filter(Boolean)) {
                const part = classifyClosingLine(line, state, sender);
                if (!part) continue;
                state = part.next;
                closingLines.push({ role: part.role, text: part.text });
            }
            index++;
        }

        if (!closingLines.length) continue;
        result.push({
            type: 'closing',
            text: closingLines.map(line => line.text).join('\n'),
            closingLines,
        });
    }

    return result;
};

const demoteSignOffOnlyClosing = sections =>
    sections.map(section => {
        if (section.type !== 'closing' || !section.closingLines?.length) return section;
        if (section.closingLines.some(line => line.role !== 'signoff')) return section;
        return { type: 'content', text: section.text };
    });

const promoteSignOffReplyToContent = sections => {
    if (sections.some(section => section.type === 'content')) return sections;

    const closingIndex = sections.findIndex(isClosingSection);
    if (closingIndex === -1) return sections;

    const closing = sections[closingIndex];
    const lines = closing.closingLines ?? [];
    const signoffLines = [];
    let index = 0;
    while (index < lines.length && lines[index].role === 'signoff') {
        signoffLines.push(lines[index]);
        index++;
    }

    const tail = lines.slice(index);
    if (!signoffLines.length || !tail.length) return sections;

    return [
        ...sections.filter((_, i) => i !== closingIndex),
        { type: 'content', text: signoffLines.map(line => line.text).join('\n') },
        { type: 'closing', text: tail.map(line => line.text).join('\n'), closingLines: tail },
    ];
};

const isClosingSection = section => section?.type === 'closing';
const firstClosingIndex = sections => sections.findIndex(isClosingSection);

const classifySections = (groups, suffixLines, detector) => {
    const suffixSet = new Set((suffixLines ?? []).map(line => line.trim()).filter(Boolean));
    let quoteMode = false;
    let signatureMode = false;

    return groups.map((group, index) => {
        const text = group.lines.join('\n');

        if (group.quoted || group.header) {
            quoteMode = true;
            return { text, type: 'quote' };
        }
        if (DISCLAIMER.test(text) && text.length >= 60) return { text, type: 'disclaimer' };
        if (FOOTER.test(text)) return { text, type: 'footer' };
        if (quoteMode) return { text, type: 'quote' };

        if (group.inlineSignature || group.senderAnchored) {
            signatureMode = true;
            return { text, type: 'signature' };
        }

        // After a sign-off, short fact-free blocks (name / title / company) are still the signature.
        const learned = suffixSet.size > 0 && group.lines.every(line => suffixSet.has(cleanLine(line)));
        const closingCandidate = group.lines.every(line => isSignatureCandidateLine(line, detector, suffixSet));
        const continuation = signatureMode && (isClosingShaped(group.lines, detector) || closingCandidate);
        if (learned || group.signoff || continuation || group.inlineSignature || (index > 0 && isClosingShaped(group.lines, detector))) {
            signatureMode = true;
            return { text, type: 'signature' };
        }
        if (index === 0 && group.lines.length === 1 && GREETING.test(group.lines[0])) return { text, type: 'greeting' };
        return { text, type: 'content' };
    });
};

const looksLikeQuoteBlock = (text) => {
    const lines = String(text ?? '').split('\n').map(line => line.trim()).filter(Boolean);
    if (!lines.length) return false;
    if (lines.every(line => line.startsWith('>'))) return true;
    return isQuoteHeaderLine(lines[0]);
};

const reclassifyQuoteLikeSections = sections =>
    sections.map(section =>
        section.type === 'content' && looksLikeQuoteBlock(section.text)
            ? { ...section, type: 'quote' }
            : section);

const markPostClosingQuotes = sections => {
    const closingIndex = firstClosingIndex(sections);
    if (closingIndex === -1) return sections;

    return sections.map((section, index) =>
        index > closingIndex && section.type !== 'disclaimer' && section.type !== 'footer'
            ? { ...section, type: 'quote' }
            : section);
};

// ---------- anchor: sender name / company — or the reference for machine emails ----------

const containsWord = (text, word) => new RegExp(`\\b${escapeRegex(word)}\\b`, 'i').test(text);

// A From header without a display name ("noreply@tms.com") is software-generated.
const hasSenderName = (from) => {
    const display = String(from ?? '').replace(/<[^>]+>/, '').replace(/"/g, '').trim();
    return Boolean(display) && !display.includes('@');
};

const senderHints = (from, scac) => {
    const email = extractEmail(from);
    const display = String(from ?? '').replace(/<[^>]+>/, '').replace(/"/g, '').trim();
    const hints = display.toLowerCase().split(/[^a-z0-9]+/).filter(token => token.length >= 3);

    const domainRoot = email.split('@')[1]?.split('.')[0] ?? '';
    if (domainRoot.length >= 3 && !GENERIC_DOMAINS.has(domainRoot)) hints.push(domainRoot);
    if (scac) hints.push(String(scac).toLowerCase());

    return [...new Set(hints.filter(Boolean))];
};

const referenceAnchorScore = (section, detector) => {
    if (section.type === 'quote' || section.type === 'disclaimer' || section.type === 'footer') return -1;
    const facts = detector.facts(section.text);
    if (!facts.reference) return -1;
    return 10
        + (facts.timeOrDate ? 3 : 0)
        + (facts.intent ? 2 : 0)
        + (section.type === 'content' ? 1 : 0);
};

// index -1 means no divider found: the whole email is fresh content (virtual anchor past the end)
const findAnchor = (sections, hints, detector, machine) => {
    if (machine) {
        // Use the best reference-bearing section, not blindly the first one.
        // Machine messages often repeat the same load in a preheader, body table, and footer.
        const bestReference = sections
            .map((section, index) => ({ index, score: referenceAnchorScore(section, detector) }))
            .filter(candidate => candidate.score >= 0)
            .sort((a, b) => b.score - a.score || a.index - b.index)[0];
        if (bestReference) return { index: bestReference.index, kind: 'reference' };
    }

    const signatureIndex = firstClosingIndex(sections);
    if (signatureIndex !== -1) return { index: signatureIndex, kind: 'standard' };

    // Skip the first content section — an intro like "this is Jeff from ARKA" is content, not the divider.
    const firstContent = sections.findIndex(section => section.type === 'content');
    const identityIndex = sections.findIndex((section, index) =>
        index !== firstContent
        && section.type === 'content'
        && hints.some(hint => containsWord(section.text, hint)));
    if (identityIndex !== -1) return { index: identityIndex, kind: 'standard' };

    return { index: sections.findIndex(section => section.type === 'quote'), kind: 'standard' };
};

// Share of characters living in long unbroken runs — high means links/ids, not prose.
const unspacedRatio = (text) => {
    const compact = text.replace(/\s+/g, '');
    if (!compact) return 0;
    const longChars = text.split(/\s+/).filter(token => LONG_TOKEN.test(token)).join('').length;
    return longChars / compact.length;
};

const selectableForRelevantText = section => section.type === 'content';

const fallbackIndex = sections => {
    const ranked = sections
        .map((section, index) => ({ index, section }))
        .filter(item => item.section.type === 'content')
        .sort((a, b) => b.section.weight - a.section.weight || a.index - b.index);
    return ranked[0]?.index ?? Math.max(sections.findIndex(section => section.type !== 'quote'), 0);
};

const splitLeadContentSection = (sections, detector) => {
    const firstContentIndex = sections.findIndex(section => section.type === 'content');
    if (firstContentIndex === -1) return sections;

    const section = sections[firstContentIndex];
    const lead = firstSentence(section.text);
    const rest = section.text.slice(lead.length).trim();
    if (!rest) return sections;

    const next = [...sections];
    next.splice(firstContentIndex, 1, { text: lead, type: 'content' }, { text: rest, type: 'content' });
    return next;
};

const weighOutgoingSimple = (sections, detector) => {
    const splitSections = splitLeadContentSection(sections, detector);
    const signatureIndex = firstClosingIndex(splitSections);
    const firstContentIndex = splitSections.findIndex(section => section.type === 'content');
    const lead = firstContentIndex === -1 ? '' : splitSections[firstContentIndex].text;

    const finalSections = splitSections.map((section, index) => {
        const facts = detector.facts(section.text);
        if (section.type === 'quote' || section.type === 'disclaimer' || section.type === 'footer')
            return { ...section, facts, weight: 0, kept: false };
        if (isClosingSection(section))
            return { ...section, facts, weight: ANCHOR_WEIGHT, kept: false };
        if (signatureIndex !== -1 && index > signatureIndex)
            return { ...section, facts, weight: 0, kept: false };
        if (index === firstContentIndex)
            return { ...section, facts, weight: 1, kept: true };
        if (section.type === 'content')
            return { ...section, facts, weight: OUTGOING_REST_WEIGHT, kept: false };
        return { ...section, facts, weight: GREETING_WEIGHT, kept: false };
    });

    if (!finalSections.some(section => section.kept)) {
        const index = fallbackIndex(finalSections);
        finalSections[index] = { ...finalSections[index], weight: 1, kept: true };
    }

    return {
        sections: finalSections,
        relevantText: lead || finalSections.find(section => section.kept)?.text || '',
        anchorIndex: signatureIndex,
        anchorKind: signatureIndex === -1 ? 'none' : 'standard',
    };
};

const weighOutgoingTopHeavy = (sections, detector) => {
    const signatureIndex = firstClosingIndex(sections);
    let contentRank = 0;

    const weighted = sections.map((section, index) => {
        const facts = detector.facts(section.text);
        if (section.type === 'quote' || section.type === 'disclaimer' || section.type === 'footer')
            return { ...section, facts, weight: 0 };
        if (isClosingSection(section))
            return { ...section, facts, weight: ANCHOR_WEIGHT };
        if (signatureIndex !== -1 && index > signatureIndex)
            return { ...section, facts, weight: 0 };
        if (section.type === 'content')
            return { ...section, facts, weight: Math.round(Math.max(ABOVE_FLOOR, ABOVE_TOP * ABOVE_DECAY ** contentRank++) * 100) / 100 };
        return { ...section, facts, weight: GREETING_WEIGHT };
    });

    const finalSections = weighted.map((section, index) => {
        if (signatureIndex !== -1 && index > signatureIndex) return { ...section, kept: false };
        return { ...section, kept: section.type === 'content' && section.weight >= KEEP_THRESHOLD };
    });

    if (!finalSections.some(section => section.kept)) {
        const index = fallbackIndex(finalSections);
        finalSections[index] = { ...finalSections[index], weight: 1, kept: true };
    }

    return {
        sections: finalSections,
        relevantText: finalSections.filter(section => section.kept).map(section => section.text).join('\n\n'),
        anchorIndex: signatureIndex,
        anchorKind: signatureIndex === -1 ? 'none' : 'standard',
    };
};

// ---------- weigh + select ----------

// weighEmail(body, { from, candidates, scac, suffixBySender, outgoing })
// -> { sections: [{ text, type, weight, kept }], relevantText, anchorIndex, anchorKind }
const weighEmail = (body, { from = '', candidates = [], scac = '', suffixBySender = {}, outgoing = false } = {}) => {
    const detector = createFactDetector(candidates);
    const suffixLines = suffixBySender[extractEmail(from)] ?? [];
    const rawLines = prepare(body).split('\n').map(line => line.trim());
    const anchoredGroups = anchorGroupsBySender(rawLines, from);
    const groups = anchoredGroups ?? splitGroupsForInlineSignatures(
        groupSections(rawLines),
        detector,
        suffixLines,
    );
    const sender = parseSenderName(from);
    const sections = markPostClosingQuotes(reclassifyQuoteLikeSections(
        promoteSignOffReplyToContent(demoteSignOffOnlyClosing(consolidateClosingSections(classifySections(groups, suffixLines, detector), sender))),
    ));
    if (!sections.length) return { sections: [], relevantText: '', anchorIndex: -1, anchorKind: 'none' };

    let normalizedSections = sections;

    const substantiveText = normalizedSections
        .filter(section => section.type !== 'quote' && section.type !== 'disclaimer' && section.type !== 'footer')
        .map(section => section.text)
        .join('\n');
    if (outgoing) {
        return hasSubstantiveOutgoingContent(detector, substantiveText)
            ? weighOutgoingTopHeavy(normalizedSections, detector)
            : weighOutgoingSimple(normalizedSections, detector);
    }

    const anchor = findAnchor(normalizedSections, senderHints(from, scac), detector, !hasSenderName(from));

    let aboveContentRank = 0;
    const weighted = normalizedSections.map((section, index) => {
        const base = (() => {
            if (section.type === 'disclaimer' || section.type === 'footer') return 0;

            // Machine email: the reference is the center point, weight decays outward.
            if (anchor.kind === 'reference') {
                if (index === anchor.index) return 1;
                const decayed = REFERENCE_DECAY ** Math.abs(index - anchor.index);
                if (section.type === 'quote') return Math.min(decayed, QUOTE_CAP);
                if (section.type === 'greeting') return Math.min(decayed, GREETING_WEIGHT);
                if (isClosingSection(section)) return Math.min(decayed, ANCHOR_WEIGHT);
                return decayed;
            }

            if (index === anchor.index) return section.type === 'quote' ? QUOTE_CAP : ANCHOR_WEIGHT;
            if (anchor.index === -1 || index < anchor.index) {
                if (section.type === 'quote') return QUOTE_CAP;
                if (section.type === 'greeting') return GREETING_WEIGHT;
                if (isClosingSection(section)) return ANCHOR_WEIGHT;
                return Math.max(ABOVE_FLOOR, ABOVE_TOP * ABOVE_DECAY ** aboveContentRank++);
            }
            const below = BELOW_FIRST * BELOW_DECAY ** (index - anchor.index - 1);
            return section.type === 'quote' ? Math.min(below, QUOTE_CAP) : below;
        })();

        const facts = detector.facts(section.text);
        const damped = base > 0 && !facts.reference && unspacedRatio(section.text) > UNSPACED_THRESHOLD
            ? base * UNSPACED_PENALTY
            : base;

        // Appointment facts stack only on real prose — signatures/quotes stay capped.
        const boostable = damped > 0 && section.type === 'content';
        const weight = boostable
            ? Math.min(1, damped
                + (facts.reference ? REFERENCE_BOOST : 0)
                + (facts.timeOrDate ? TIME_DATE_BOOST : 0)
                + (facts.intent ? INTENT_BOOST : 0))
            : damped;

        return { ...section, facts, weight: Math.round(weight * 100) / 100 };
    });

    let haveReference = false;
    let haveTimeOrDate = false;
    let haveIntent = false;
    let sufficient = false;
    let exhausted = false;
    let keptLength = 0;
    const requireReference = detector.references.length > 0;

    const finalSections = weighted.map((section) => {
        if (sufficient) return { ...section, weight: 0, kept: false };
        const usefulMachineSection = anchor.kind !== 'reference'
            || section.facts.reference
            || section.facts.timeOrDate
            || section.facts.intent;
        if (exhausted || section.weight < KEEP_THRESHOLD || !selectableForRelevantText(section) || !usefulMachineSection) return { ...section, kept: false };

        if (keptLength && keptLength + section.text.length > CHAR_BUDGET) {
            exhausted = true;
            return { ...section, kept: false };
        }

        keptLength += section.text.length;
        haveReference ||= section.facts.reference;
        haveTimeOrDate ||= section.facts.timeOrDate;
        haveIntent ||= section.facts.intent;

        // With known candidates, stop once we have the target reference and schedule fact.
        // Without candidates, stop once the sender gives a schedule fact plus carrier intent.
        sufficient = requireReference
            ? haveReference && haveTimeOrDate
            : haveTimeOrDate && haveIntent;

        return { ...section, kept: true };
    });

    if (!finalSections.some(section => section.kept)) {
        const index = fallbackIndex(finalSections);
        if (finalSections[index]?.type === 'content')
            finalSections[index] = { ...finalSections[index], weight: 1, kept: true };
    }

    return {
        sections: finalSections,
        relevantText: finalSections.filter(section => section.kept).map(section => section.text).join('\n\n'),
        anchorIndex: anchor.index,
        anchorKind: anchor.kind,
    };
};

module.exports = { weighEmail, isClosingSection, isSignatureSection: isClosingSection };
