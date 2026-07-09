const normalize = value => String(value ?? "").trim();

const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const normalizeReference = value => normalize(value).toLowerCase().replace(/[^a-z0-9]/g, "");

const MIN_REFERENCE_LENGTH = 5;

const findReferenceIndex = (text, reference) => {
    const token = normalize(reference);
    if (!token) return -1;

    const match = text.match(new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(token)}(?![A-Za-z0-9])`, "i"));
    if (match) return match.index;

    const normalizedText = normalizeReference(text);
    const normalizedToken = normalizeReference(token);
    if (normalizedToken.length < MIN_REFERENCE_LENGTH) return -1;

    const index = normalizedText.indexOf(normalizedToken);
    return index >= 0 ? index : -1;
};

const candidateReferences = candidates =>
    candidates
        .flatMap(candidate => {
            const loadNumber = normalize(candidate.loadNumber);
            const proNumber = normalize(candidate.proNumber);
            const items = [];
            if (loadNumber) items.push({ candidate, reference: loadNumber });
            if (proNumber && proNumber !== loadNumber) items.push({ candidate, reference: proNumber });
            return items;
        })
        .filter(({ reference }) => reference)
        .sort((a, b) => b.reference.length - a.reference.length);

const matchCandidate = (text, candidates) => {
    const haystack = normalize(text);
    if (!haystack || !candidates.length) return null;

    const match = candidateReferences(candidates)
        .map(entry => ({ ...entry, index: findReferenceIndex(haystack, entry.reference) }))
        .filter(entry => entry.index >= 0)
        .sort((a, b) => a.index - b.index || b.reference.length - a.reference.length)[0];

    return match?.candidate ?? null;
};

const buildThreadSearchText = (thread) => {
    const parts = [thread.subject];

    for (const message of thread.messages ?? []) {
        if (message.subject) parts.push(message.subject);
        if (message.body) parts.push(message.body);
    }

    return parts.join(" ");
};

const resolveThreadLoad = (thread, candidates, existing = {}) => {
    const existingLoad = normalize(existing.loadNumber);
    if (existingLoad) {
        return {
            loadNumber: existingLoad,
            proNumber: normalize(existing.proNumber),
            scac: existing.scac || "",
        };
    }

    const match = matchCandidate(buildThreadSearchText(thread), candidates);
    if (!match) return null;

    return {
        loadNumber: normalize(match.loadNumber),
        proNumber: normalize(match.proNumber),
        scac: match.scac || "",
    };
};

module.exports = {
    normalize,
    matchCandidate,
    buildThreadSearchText,
    resolveThreadLoad,
};
