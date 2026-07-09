// Section-weighting for carrier emails: label lines by role, fold into macro
// sections (greeting / content / closing / quote), weight by section type with
// appointment-fact boosts on content only.
// CommonJS mirror of client/src/renderer/src/utils/emailWeight.js — keep both in sync.

// ---------- tunables ----------

const ABOVE_TOP = 1;
const ABOVE_DECAY = 0.85;
const ABOVE_FLOOR = 0.6;
const GREETING_WEIGHT = 0.2;
const ANCHOR_WEIGHT = 0.25;
const BELOW_FIRST = 0.3;
const BELOW_DECAY = 0.5;
const QUOTE_CAP = 0.2;
const REFERENCE_DECAY = 0.7;
const KEEP_THRESHOLD = 0.3;
const CHAR_BUDGET = 1500;

const REFERENCE_BOOST = 0.3;
const TIME_DATE_BOOST = 0.2;
const INTENT_BOOST = 0.15;

const LONG_TOKEN = /\S{20,}/;
const UNSPACED_THRESHOLD = 0.4;
const UNSPACED_PENALTY = 0.3;

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

const SIGN_OFF = /^(thanks|thank you|many thanks|thx|thanks?\s*(and|&)\s*regards|best|(with )?(kind|best|warm) regards|regards|sincerely|cheers|respectfully|take care|godspeed|warmly|all the best|yours truly|cordially)\s*[,!.]*$/i;
const SIGN_OFF_SHORT = /^(thanks?|best|regards|sincerely|cheers|respectfully|godspeed|warmly)\s*[,!.]*$/i;
const TITLE_HINTS = /\b(manager|director|coordinator|specialist|supervisor|dispatcher|representative|rep|analyst|assistant|associate|lead|clerk|agent|executive|officer|president|vp|head|captain|planner|account)\b/i;
const GREETING = /^(hi|hello|hey|dear|good (morning|afternoon|evening))\b[^,\n]{0,40}[,!.]*$/i;
const DISCLAIMER = /confidential|privileged|intended (recipient|solely)|do not (disseminate|distribute)|received this (e-?mail )?in error/i;
const FOOTER = /^sent from my |unsubscribe|view (this|it) in your browser/im;
const PHONE = /(\(\d{3}\)\s*\d{3}[-.\s]?\d{4})|(\b\d{3}[-.]\d{3}[-.]\d{4}\b)|(\+\d{1,2}[\s.-]?\d{3}[\s.-]?\d{3}[\s.-]?\d{4})/;
const URL = /(https?:\/\/|www\.)\S+/i;
const EMBEDDED_CID = /\[cid:[^\]]+\]/i;
const CONTACT_PREFIX = /^(email|office|phone|mobile|tel|fax|e-mail):\s*/i;

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

const SIGNATURE_TAIL_ROLES = new Set(['title', 'company', 'contact', 'address', 'slogan', 'link', 'gibberish']);

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
            if (reference.raw.length >= MIN_NORMALIZED_REFERENCE_LENGTH && rawText.includes(reference.raw.toLowerCase())) return true;
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
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g, '-')
    .replace(/\*([^*\n]+)\*/g, '$1')
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

const isShortFarewell = (line) => {
    const trimmed = cleanLine(line);
    if (!trimmed) return false;
    if (isSignOffLine(trimmed)) return true;
    if (looksLikeJobTitle(trimmed) || TITLE_HINTS.test(trimmed)) return false;
    const words = trimmed.split(/\s+/).filter(Boolean);
    if (words.length > 3 || !words.length) return false;
    if (PHONE.test(trimmed) || EMAIL_IN_LINE.test(trimmed) || URL.test(trimmed)) return false;
    if (words.length > 1 && trimmed.includes('.')) return false;
    return /^[A-Za-z][A-Za-z\s'-]*[,!.]*$/.test(trimmed) && words.length <= 2;
};

const looksLikeAddressLine = (line) => {
    const trimmed = cleanLine(line);
    if (!trimmed) return false;
    if (/\bP\.?\s*O\.?\s*Box\b/i.test(trimmed)) return true;
    if (/^\d{1,6}\s+\S/.test(trimmed) && /\b(ave|avenue|st|street|rd|road|blvd|boulevard|drive|dr|lane|ln|way|court|ct|pkwy|parkway|hwy|highway)\b/i.test(trimmed)) return true;
    return /\b[A-Z]{2}\s+\d{5}(-\d{4})?\b/.test(trimmed) && /\d/.test(trimmed);
};

const prepare = body => String(body ?? '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/\r\n?/g, '\n')
    .replace(/(-{2,}\s*(?:Original|Forwarded) Message\s*-{2,})/gi, '\n$1\n')
    .replace(/([^\n])[ \t]+(On (?:Mon|Tue|Wed|Thu|Fri|Sat|Sun|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec|\d)[^\n]{3,160}? wrote:)/g, '$1\n$2\n');

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

const isContactLine = line => PHONE.test(cleanLine(line)) || EMAIL_IN_LINE.test(line) || /<tel:/i.test(line) || /<mailto:/i.test(line) || CONTACT_PREFIX.test(cleanLine(line));
const isLinkLine = line => URL.test(cleanLine(line));
const isGibberishLine = line => EMBEDDED_CID.test(cleanLine(line));
const isPipeGibberish = line => {
    const trimmed = cleanLine(line);
    return trimmed.includes('|') && trimmed.split('|').filter(part => part.trim()).length >= 3;
};
const isBracketCompany = line => /^\[[^\]]+\]$/.test(cleanLine(line));
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

const looksLikeNameCandidate = (line, sender) => {
    const trimmed = cleanLine(line);
    if (!trimmed || trimmed === '|') return false;
    if (lineContainsSenderName(trimmed, sender) || looksLikePersonName(trimmed)) return true;
    if (!sender) return false;
    return new RegExp(`^${escapeRegex(sender.first)}$`, 'i').test(trimmed);
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

const looksLikeSlogan = (line, detector) => {
    const trimmed = cleanLine(line);
    if (!trimmed || trimmed.length <= 50) return false;
    if (isContactLine(trimmed) || isLinkLine(trimmed) || looksLikeAddressLine(trimmed)) return false;
    if (isPipeGibberish(trimmed) || isBracketCompany(trimmed)) return false;
    if (detector.hasTimeOrDate(trimmed) || detector.hasReference(trimmed)) return false;
    if (/\b(will|can|please|reach|back out|as soon|let me know|need to|want to|reschedul|confirm)\b/i.test(trimmed)) return false;
    if (detector.hasIntent(trimmed) && !/\b(largest|nation'?s|leading|premier|veteran|owned business|provider|since \d{4})\b/i.test(trimmed)) return false;
    return true;
};

const looksLikeCompanyTagline = (line) => {
    const trimmed = cleanLine(line);
    if (!trimmed || trimmed.length > 60) return false;
    if (isSignOffLine(trimmed)) return false;
    if (/^thank\b/i.test(trimmed) || /\b(you too|thanks again|much appreciated)\b/i.test(trimmed)) return false;
    if (/\b(we'?re|pulling for you|for you)\b/i.test(trimmed)) return true;
    if (looksLikePersonName(trimmed) || looksLikeJobTitle(trimmed)) return false;
    return isShortWorded(trimmed) && /!$/.test(trimmed) && /\b(for you|pulling)\b/i.test(trimmed);
};

const isSignatureLeadLine = (line, sender, detector) => {
    const trimmed = cleanLine(line);
    if (isSignOffLine(trimmed)) return true;
    if (isGibberishLine(trimmed) || isPipeGibberish(trimmed)) return true;
    if (isLinkLine(trimmed) && !/\b(office|cell|phone|ext\.)\b/i.test(trimmed)) return true;
    if (looksLikeSlogan(trimmed, detector) || looksLikeCompanyTagline(trimmed)) return true;
    return false;
};

const expandSignaturePreludeStart = (nonEmpty, startIndex, sender, detector) => {
    let start = startIndex;
    while (start > 0) {
        const prev = nonEmpty[start - 1].text;
        if (isProseContentLine(prev, detector, sender)) break;
        const trimmedPrev = cleanLine(prev);
        if (/^thank\b/i.test(trimmedPrev) && !isSignOffLine(trimmedPrev)) break;
        if (/\b(you too|thanks again)\b/i.test(trimmedPrev)) break;
        if (isSignatureLeadLine(prev, sender, detector)) {
            start--;
            continue;
        }
        break;
    }
    return start;
};

const looksLikeCompanyLine = (line, sender) => {
    const trimmed = cleanLine(line);
    if (isBracketCompany(trimmed)) return true;
    if (sender && lineContainsSenderName(trimmed, sender)) return false;
    return /\b(freight|transport|logistics|trucking|manufacturing|inc\.?|llc|corp|corporation|ltd)\b/i.test(trimmed);
};

const countNameLines = (lines, sender) =>
    lines.filter(line => looksLikeNameCandidate(line, sender) && !looksLikeCompanyLine(line, sender)).length;

const validateClosingBlock = (lines, sender, detector) => {
    const cleaned = lines.map(cleanLine).filter(line => line && line !== '|');
    if (cleaned.length < 2) return false;
    if (cleaned.some(line => detector.hasTimeOrDate(line) || detector.hasReference(line))) return false;

    const nameCount = countNameLines(cleaned, sender);
    if (nameCount > 1) return false;
    if (nameCount === 0 && !cleaned.some(isSignOffLine)) return false;

    const nameIndex = cleaned.findIndex(line => looksLikeNameCandidate(line, sender));
    if (nameCount === 0) {
        const signoffCount = cleaned.filter(isSignOffLine).length;
        return signoffCount > 0 && signoffCount === cleaned.length;
    }

    const afterName = cleaned.slice(nameIndex + 1);
    const hasTitle = afterName.some(looksLikeJobTitle);
    const hasContact = afterName.some(isContactLine);
    const hasAddress = afterName.some(looksLikeAddressLine);
    const hasTail = afterName.length >= 1;

    if (nameCount === 1 && cleaned.some(isSignOffLine) && !afterName.length) return true;

    if (hasTitle || hasContact || hasAddress) return true;
    if (hasTail && !afterName.some(line => looksLikePersonName(line) && !looksLikeNameCandidate(line, sender))) return true;
    return afterName.some(line => isLinkLine(line) || isGibberishLine(line) || isPipeGibberish(line) || looksLikeSlogan(line, detector));
};

const isSignatureTailLine = (line, sender, detector) => {
    const trimmed = cleanLine(line);
    if (!trimmed || trimmed === '|') return false;
    if (isContactLine(trimmed) || isLinkLine(trimmed) || isGibberishLine(trimmed) || isPipeGibberish(trimmed)) return true;
    if (looksLikeAddressLine(trimmed) || looksLikeJobTitle(trimmed) || looksLikeCompanyLine(trimmed, sender) || looksLikeSlogan(trimmed, detector)) return true;
    if (isBracketCompany(trimmed) || isSignOffLine(trimmed)) return true;
    if (detector.hasTimeOrDate(trimmed) || detector.hasReference(trimmed) || detector.hasIntent(trimmed)) return false;
    if (looksLikeNameCandidate(trimmed, sender)) return false;
    return isShortWorded(trimmed) && trimmed.length <= 80;
};

const extendClosingEnd = (nonEmpty, start, sender, detector) => {
    const nameIdx = nonEmpty.slice(start).findIndex(item =>
        looksLikeNameCandidate(item.text, sender) || splitNameTitleHyphen(item.text, sender));
    if (nameIdx === -1) return Math.min(start + 1, nonEmpty.length);

    let end = start + nameIdx + 1;
    while (end < nonEmpty.length) {
        if (nonEmpty[end].text === '|') {
            end++;
            continue;
        }
        if (!isSignatureTailLine(nonEmpty[end].text, sender, detector)) break;
        end++;
    }
    return end;
};

const labelPreliminaryRole = (line, sender, detector) => {
    const trimmed = cleanLine(line);
    if (!trimmed || trimmed === '|') return null;
    if (isSignOffLine(trimmed)) return 'signoff';
    if (isContactLine(trimmed)) return 'contact';
    if (isLinkLine(trimmed)) return 'link';
    if (isGibberishLine(trimmed) || isPipeGibberish(trimmed)) return 'gibberish';
    if (looksLikeAddressLine(trimmed)) return 'address';
    if (splitNameTitleHyphen(trimmed, sender)) return 'name';
    if (looksLikeNameCandidate(trimmed, sender) && !looksLikeCompanyLine(trimmed, sender)) return 'name';
    if (looksLikeJobTitle(trimmed)) return 'title';
    if (looksLikeCompanyLine(trimmed, sender) || isBracketCompany(trimmed)) return 'company';
    if (looksLikeSlogan(trimmed, detector)) return 'slogan';
    if (detector.hasTimeOrDate(trimmed) || detector.hasReference(trimmed)) return 'content';
    if (detector.hasIntent(trimmed) && trimmed.length > 40) return 'content';
    return null;
};

const signatureCorePresent = (roles, start, end) => {
    let name = false;
    let title = false;
    let company = false;
    let contact = false;

    for (let i = start; i <= end; i++) {
        const text = roles[i]?.text ?? '';
        if (roles[i]?.role === 'name' || splitNameTitleHyphen(text, roles[i]?.sender)) name = true;
        if (roles[i]?.role === 'title' || splitNameTitleHyphen(text, roles[i]?.sender)) title = true;
        if (roles[i]?.role === 'company') company = true;
        if (roles[i]?.role === 'contact') contact = true;
    }

    return name && title && company && contact;
};

const isProseContentLine = (line, detector, sender) => {
    const trimmed = cleanLine(line);
    if (!trimmed) return false;
    if (detector.hasReference(trimmed) || detector.hasTimeOrDate(trimmed)) return true;
    if (detector.hasIntent(trimmed) && trimmed.length > 35 && !isContactLine(trimmed) && !looksLikeJobTitle(trimmed)) return true;
    if (trimmed.length > 120) return true;
    if (looksLikeNameCandidate(trimmed, sender) || isSignOffLine(trimmed)) return false;
    return trimmed.split(/\s+/).filter(Boolean).length > 8;
};

const findSignatureCoreRange = (nonEmpty, sender, detector) => {
    const labeled = nonEmpty.map(item => ({
        ...item,
        role: labelPreliminaryRole(item.text, sender, detector),
        sender,
    }));

    const coreIndices = labeled
        .map((item, index) => ({ index, role: item.role }))
        .filter(item => ['name', 'title', 'company', 'contact'].includes(item.role));

    if (coreIndices.length < 4) return null;

    for (let anchor = coreIndices.length - 1; anchor >= 0; anchor--) {
        const anchorIndex = coreIndices[anchor].index;
        let start = anchorIndex;
        let end = anchorIndex;

        while (!signatureCorePresent(labeled, start, end)) {
            const canGrowEnd = end < nonEmpty.length - 1;
            const canGrowStart = start > 0;
            if (!canGrowEnd && !canGrowStart) break;

            const growEndScore = canGrowEnd
                ? ['name', 'title', 'company', 'contact'].includes(labeled[end + 1]?.role) ? 2 : 0
                : -1;
            const growStartScore = canGrowStart
                ? ['name', 'title', 'company', 'contact'].includes(labeled[start - 1]?.role) ? 2 : 0
                : -1;

            if (growEndScore >= growStartScore && canGrowEnd) end++;
            else if (canGrowStart) start--;
            else if (canGrowEnd) end++;
        }

        if (!signatureCorePresent(labeled, start, end)) continue;
        if (labeled.slice(start, end + 1).some(item => item.role === 'content' || isProseContentLine(item.text, detector, sender))) continue;

        let expandedEnd = end + 1;
        while (expandedEnd < nonEmpty.length && isSignatureTailLine(nonEmpty[expandedEnd].text, sender, detector)) expandedEnd++;

        return { start, end: expandedEnd };
    }

    return null;
};

const findClosingRangeByNameAnchor = (nonEmpty, sender, detector) => {
    for (let i = nonEmpty.length - 1; i >= 0; i--) {
        const text = nonEmpty[i].text;
        if (!looksLikeNameCandidate(text, sender) && !splitNameTitleHyphen(text, sender)) continue;

        let start = i;
        while (start > 0 && isSignOffLine(nonEmpty[start - 1].text)) start--;

        const end = extendClosingEnd(nonEmpty, start, sender, detector);
        const block = nonEmpty.slice(start, end).map(item => item.text);
        if (!validateClosingBlock(block, sender, detector)) continue;
        return { start, end };
    }

    return null;
};

const expandClosingStart = (nonEmpty, startIndex, sender, detector) => {
    let start = startIndex;
    while (start > 0) {
        const prev = nonEmpty[start - 1].text;
        if (isProseContentLine(prev, detector, sender)) break;
        if (isSignOffLine(prev) || looksLikeNameCandidate(prev, sender) || isSignatureTailLine(prev, sender, detector)) {
            start--;
            continue;
        }
        break;
    }
    return start;
};

const findClosingRangeBySuffix = (nonEmpty, sender, suffixLines, detector) => {
    if (!suffixLines?.length) return null;

    for (let start = nonEmpty.length - suffixLines.length; start >= 0; start--) {
        const tail = nonEmpty.slice(start, start + suffixLines.length).map(item => item.text);
        if (!suffixLines.every((line, index) => tail[index] === line)) continue;

        const end = start + suffixLines.length;
        start = expandClosingStart(nonEmpty, start, sender, detector);
        const block = nonEmpty.slice(start, end).map(item => item.text);
        if (!validateClosingBlock(block, sender, detector)) continue;
        return { start, end };
    }

    return null;
};

const finalizeClosingRange = (range, nonEmpty, sender, detector) => {
    if (!range) return null;

    const nameIdx = nonEmpty.findIndex((item, idx) =>
        idx >= range.start && idx < range.end
        && (looksLikeNameCandidate(item.text, sender) || splitNameTitleHyphen(item.text, sender)));
    const pivot = nameIdx === -1 ? range.start : nameIdx;
    const start = expandSignaturePreludeStart(nonEmpty, pivot, sender, detector);

    return start < range.end ? { start, end: range.end } : null;
};

const findClosingRange = (nonEmpty, sender, suffixLines, suffixSet, detector) => {
    if (nonEmpty.length < 2) return null;

    return finalizeClosingRange(findSignatureCoreRange(nonEmpty, sender, detector), nonEmpty, sender, detector)
        ?? finalizeClosingRange(findClosingRangeBySuffix(nonEmpty, sender, suffixLines, detector), nonEmpty, sender, detector)
        ?? finalizeClosingRange(findClosingRangeByNameAnchor(nonEmpty, sender, detector), nonEmpty, sender, detector);
};

const classifyClosingLine = (line, state, sender, detector) => {
    const trimmed = cleanLine(line);
    if (!trimmed || trimmed === '|') return null;
    if (isSignOffLine(trimmed)) return { text: trimmed, role: 'signoff', next: { ...state, seenSignoff: true } };
    if (isLinkLine(trimmed)) return { text: trimmed, role: 'link', next: state };
    if (isGibberishLine(trimmed) || isPipeGibberish(trimmed)) return { text: trimmed, role: 'gibberish', next: state };
    if (isContactLine(trimmed)) return { text: trimmed, role: 'contact', next: state };
    if (state.seenSignoff && !state.seenName && looksLikeCompanyTagline(trimmed))
        return { text: trimmed, role: 'slogan', next: state };
    if (!state.seenName && sender && lineContainsSenderName(trimmed, sender))
        return { text: trimmed, role: 'name', next: { ...state, seenName: true } };
    if (!state.seenName && looksLikeNameCandidate(trimmed, sender))
        return { text: trimmed, role: 'name', next: { ...state, seenName: true } };
    if (state.seenSignoff && !state.seenName && looksLikeNameCandidate(trimmed, sender))
        return { text: trimmed, role: 'name', next: { ...state, seenName: true } };
    if (state.seenName && looksLikeAddressLine(trimmed)) return { text: trimmed, role: 'address', next: state };
    if (state.seenName && !state.seenTitle && TITLE_HINTS.test(trimmed))
        return { text: trimmed, role: 'title', next: { ...state, seenTitle: true } };
    if (state.seenName && !state.seenTitle && looksLikeCompanyLine(trimmed, sender))
        return { text: trimmed, role: 'company', next: { ...state, seenTitle: true } };
    if (state.seenName && !state.seenTitle && looksLikeJobTitle(trimmed))
        return { text: trimmed, role: 'title', next: { ...state, seenTitle: true } };
    if (state.seenName && looksLikeSlogan(trimmed, detector))
        return { text: trimmed, role: 'slogan', next: state };
    if (state.seenName && isBracketCompany(trimmed))
        return { text: trimmed, role: 'company', next: state };
    if (state.seenName && isShortWorded(trimmed) && trimmed.length <= 80)
        return { text: trimmed, role: 'company', next: state };
    if (!state.seenSignoff && isShortFarewell(trimmed))
        return { text: trimmed, role: 'signoff', next: { ...state, seenSignoff: true } };
    if (state.seenName) return { text: trimmed, role: 'gibberish', next: state };
    return { text: trimmed, role: 'gibberish', next: state };
};

const buildClosingSection = (lines, sender, detector) => {
    const expanded = expandClosingInputLines(lines, sender);
    const closingLines = [];
    let state = { seenSignoff: false, seenName: false, seenTitle: false };

    expanded.forEach((line) => {
        const part = classifyClosingLine(line, state, sender, detector);
        if (!part) return;
        state = part.next;
        closingLines.push({ role: part.role, text: part.text });
    });

    if (!closingLines.length) return null;
    return {
        type: 'closing',
        text: closingLines.map(line => line.text).join('\n'),
        closingLines,
    };
};

const splitParagraphSections = (lines, type) => {
    const sections = [];
    let current = [];

    lines.forEach((line) => {
        const trimmed = line.trim();
        if (!trimmed) {
            if (current.length) {
                sections.push({ type, text: current.join('\n') });
                current = [];
            }
            return;
        }
        current.push(trimmed);
    });

    if (current.length) sections.push({ type, text: current.join('\n') });
    return sections;
};

const foldSections = (body, { from, suffixLines = [], detector }) => {
    const sender = parseSenderName(from);
    const suffixSet = new Set((suffixLines ?? []).map(line => cleanLine(line)).filter(Boolean));
    const allLines = prepare(body).split('\n');

    let quoteStart = allLines.length;
    for (let i = 0; i < allLines.length; i++) {
        const trimmed = allLines[i].trim();
        if (!trimmed) continue;
        if (trimmed.startsWith('>') || isQuoteHeader(allLines.map(line => line.trim()), i)) {
            quoteStart = i;
            break;
        }
    }

    const bodyLines = allLines.slice(0, quoteStart);
    const quoteLines = allLines.slice(quoteStart);
    const nonEmpty = bodyLines
        .map((text, index) => ({ text: text.trim(), index }))
        .filter(item => item.text);

    const closingRange = findClosingRange(nonEmpty, sender, suffixLines, suffixSet, detector);
    const sections = [];

    if (!closingRange) {
        sections.push(...splitParagraphSections(bodyLines, 'content'));
    } else {
        const prefixEnd = nonEmpty[closingRange.start].index;
        const closingEnd = nonEmpty[closingRange.end - 1].index + 1;
        const prefixLines = bodyLines.slice(0, prefixEnd);
        const closingLines = bodyLines.slice(prefixEnd, closingEnd).map(line => line.trim()).filter(Boolean);
        const afterClosingLines = bodyLines.slice(closingEnd);
        const closing = buildClosingSection(closingLines, sender, detector);

        sections.push(...splitParagraphSections(prefixLines, 'content'));
        if (closing) sections.push(closing);
        sections.push(...splitParagraphSections(afterClosingLines, 'content'));
    }

    sections.push(...splitParagraphSections(quoteLines, 'quote'));

    if (sections.length && sections[0].type === 'content') {
        const firstLine = sections[0].text.split('\n')[0]?.trim() ?? '';
        if (GREETING.test(firstLine) && sections[0].text.split('\n').filter(Boolean).length === 1)
            sections[0] = { type: 'greeting', text: sections[0].text };
    }

    return sections
        .map((section) => {
            if (section.type !== 'content') return section;
            if (DISCLAIMER.test(section.text) && section.text.length >= 60) return { type: 'disclaimer', text: section.text };
            if (FOOTER.test(section.text)) return { type: 'footer', text: section.text };
            return section;
        })
        .filter(section => section.text?.trim());
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

    const keepSignoffInClosing = signoffLines.some(line => /[,!]$/.test(line.text.trim()));
    if (keepSignoffInClosing) return sections;

    return [
        ...sections.filter((_, i) => i !== closingIndex),
        { type: 'content', text: signoffLines.map(line => line.text).join('\n') },
        { type: 'closing', text: tail.map(line => line.text).join('\n'), closingLines: tail },
    ];
};

const isClosingSection = section => section?.type === 'closing';
const firstClosingIndex = sections => sections.findIndex(isClosingSection);

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

const containsWord = (text, word) => new RegExp(`\\b${escapeRegex(word)}\\b`, 'i').test(text);

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

const findAnchor = (sections, hints, detector, machine) => {
    if (machine) {
        const bestReference = sections
            .map((section, index) => ({ index, score: referenceAnchorScore(section, detector) }))
            .filter(candidate => candidate.score >= 0)
            .sort((a, b) => b.score - a.score || a.index - b.index)[0];
        if (bestReference) return { index: bestReference.index, kind: 'reference' };
    }

    const signatureIndex = firstClosingIndex(sections);
    if (signatureIndex !== -1) return { index: signatureIndex, kind: 'standard' };

    const firstContent = sections.findIndex(section => section.type === 'content');
    const identityIndex = sections.findIndex((section, index) =>
        index !== firstContent
        && section.type === 'content'
        && hints.some(hint => containsWord(section.text, hint)));
    if (identityIndex !== -1) return { index: identityIndex, kind: 'standard' };

    return { index: sections.findIndex(section => section.type === 'quote'), kind: 'standard' };
};

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
    return ranked[0]?.index ?? Math.max(sections.findIndex(section => section.type === 'content'), 0);
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

const weighEmail = (body, { from = '', candidates = [], scac = '', suffixBySender = {}, outgoing = false } = {}) => {
    const detector = createFactDetector(candidates);
    const suffixLines = suffixBySender[extractEmail(from)] ?? [];
    const sections = markPostClosingQuotes(reclassifyQuoteLikeSections(
        promoteSignOffReplyToContent(demoteSignOffOnlyClosing(foldSections(body, { from, suffixLines, detector }))),
    ));
    if (!sections.length) return { sections: [], relevantText: '', anchorIndex: -1, anchorKind: 'none' };

    const substantiveText = sections
        .filter(section => section.type !== 'quote' && section.type !== 'disclaimer' && section.type !== 'footer')
        .map(section => section.text)
        .join('\n');
    if (outgoing) {
        return hasSubstantiveOutgoingContent(detector, substantiveText)
            ? weighOutgoingTopHeavy(sections, detector)
            : weighOutgoingSimple(sections, detector);
    }

    const anchor = findAnchor(sections, senderHints(from, scac), detector, !hasSenderName(from));

    let aboveContentRank = 0;
    const weighted = sections.map((section, index) => {
        const base = (() => {
            if (section.type === 'disclaimer' || section.type === 'footer') return 0;

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

