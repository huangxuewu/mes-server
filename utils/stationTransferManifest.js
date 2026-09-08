const validateTransferManifest = input => {
    if (!input || !['file', 'folder'].includes(input.kind) || typeof input.name !== 'string' || !Array.isArray(input.entries)
        || input.entries.length > 10000 || JSON.stringify(input).length > 2 * 1024 * 1024) throw new Error('invalidTransfer');
    const safePart = value => !!value && value.length <= 255 && !/[<>:"\\|?*\x00-\x1f]/.test(value)
        && !/[. ]$/.test(value) && !['.', '..'].includes(value) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value);
    if (!safePart(input.name) || input.name.includes('/')) throw new Error('invalidTransfer');
    const paths = new Map();
    let total = 0, files = 0;
    const entries = input.entries.map(entry => {
        if (!entry || typeof entry.path !== 'string' || entry.path.length > 1024 || !entry.path.split('/').every(safePart)
            || !['file', 'directory'].includes(entry.type) || paths.has(entry.path.toLowerCase())) throw new Error('invalidTransfer');
        const size = entry.type === 'directory' ? 0 : entry.size;
        if (!Number.isSafeInteger(size) || size < 0) throw new Error('invalidTransfer');
        paths.set(entry.path.toLowerCase(), entry.type);
        total += size; if (entry.type === 'file') files++;
        if (!Number.isSafeInteger(total)) throw new Error('invalidTransfer');
        return { path: entry.path, type: entry.type, size };
    });
    for (const entry of entries) {
        const parts = entry.path.toLowerCase().split('/'); parts.pop();
        while (parts.length) { if (paths.get(parts.join('/')) !== 'directory') throw new Error('invalidTransfer'); parts.pop(); }
    }
    if (input.kind === 'file' && (entries.length !== 1 || entries[0].type !== 'file' || entries[0].path !== input.name)) throw new Error('invalidTransfer');
    return { kind: input.kind, name: input.name, entries, total, files };
};

module.exports = { validateTransferManifest };
