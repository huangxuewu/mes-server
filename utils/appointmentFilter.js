const normalize = value => String(value ?? "").trim();

const matchCandidate = (text, candidates) => {
    const haystack = normalize(text);
    if (!haystack || !candidates.length) return null;

    return candidates.find((candidate) => {
        const loadNumber = normalize(candidate.loadNumber);
        const proNumber = normalize(candidate.proNumber);

        return (loadNumber && haystack.includes(loadNumber))
            || (proNumber && haystack.includes(proNumber));
    }) ?? null;
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
