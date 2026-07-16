const STORAGE_UNIT_PROFILES = {
    piece: { pickLevels: ['piece', 'pallet'] },
    unit: { pickLevels: ['unit', 'pallet'] },
    box: { pickLevels: ['unit', 'box', 'pallet'] },
    bag: { pickLevels: ['bag', 'pallet'] },
    bale: { pickLevels: ['bale', 'pallet'] },
    roll: { pickLevels: ['roll', 'pallet'] },
    tote: { pickLevels: ['tote', 'pallet'] },
};

const resolveStorageUnit = (value) => {
    const unit = value || 'box';
    return unit === 'case' ? 'unit' : unit;
};

const resolvePickLevel = (value) => (value === 'case' ? 'unit' : value);

/** Always at least 1 when unset or 0 */
const resolvePiecesPerUnit = (value) => {
    const n = Number(value);
    return n > 0 ? n : 1;
};

const getStorageUnitProfile = storageUnit =>
    STORAGE_UNIT_PROFILES[resolveStorageUnit(storageUnit)] ?? STORAGE_UNIT_PROFILES.box;

const normalizeStorage = (storage = {}) => {
    const storageUnit = resolveStorageUnit(storage.storageUnit);
    const piecesPerUnit = resolvePiecesPerUnit(storage.piecesPerUnit);
    const legacyCasePack = Math.max(0, Number(storage.casePack) || 0);
    const unitsPerBox = Math.max(0, Number(storage.unitsPerBox) || legacyCasePack || 0);
    const boxesPerPallet = Math.max(0, Number(storage.boxesPerPallet) || 0);
    const unitsPerPallet = Math.max(0, Number(storage.unitsPerPallet) || 0);
    const profile = getStorageUnitProfile(storageUnit);
    const pickLevel = resolvePickLevel(storage.defaultPickLevel);
    const defaultPickLevel = profile.pickLevels.includes(pickLevel)
        ? pickLevel
        : (profile.pickLevels[0] || 'box');

    return {
        location: storage.location ?? '',
        storageUnit,
        piecesPerUnit,
        unitsPerBox,
        boxesPerPallet,
        unitsPerPallet,
        defaultPickLevel,
        maxHeight: Math.max(0, Number(storage.maxHeight) || 0),
        allowOverHang: !!storage.allowOverHang,
        allowStacking: !!storage.allowStacking,
    };
};

const unitsPerPalletTotal = (storage = {}) => {
    const normalized = normalizeStorage(storage);
    if (normalized.storageUnit === 'piece' || normalized.storageUnit === 'unit')
        return normalized.unitsPerPallet;
    if (normalized.storageUnit === 'bale') return 0;
    return normalized.unitsPerBox * normalized.boxesPerPallet;
};

const validateStorage = (storage = {}) => {
    const normalized = normalizeStorage(storage);
    return { normalized, errors: [] };
};

module.exports = {
    normalizeStorage,
    resolvePiecesPerUnit,
    unitsPerPallet: unitsPerPalletTotal,
    validateStorage,
};
