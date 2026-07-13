const STORAGE_UNIT_PROFILES = {
    box: { pickLevels: ['case', 'box', 'pallet'] },
    piece: { pickLevels: ['piece', 'pallet'] },
    case: { pickLevels: ['case', 'pallet'] },
    bag: { pickLevels: ['bag', 'pallet'] },
    bale: { pickLevels: ['bale', 'pallet'] },
    roll: { pickLevels: ['roll', 'pallet'] },
    tote: { pickLevels: ['tote', 'pallet'] },
};

const getStorageUnitProfile = storageUnit =>
    STORAGE_UNIT_PROFILES[storageUnit] ?? STORAGE_UNIT_PROFILES.box;

const normalizeStorage = (storage = {}) => {
    const storageUnit = storage.storageUnit || 'box';
    const casePack = Math.max(0, Number(storage.casePack) || 0);
    const legacyUnitsPerBox = Number(storage.unitsPerBox);
    const legacyCaseAsBox = storageUnit === 'box' ? casePack : 0;
    const unitsPerBox = Math.max(0, Number.isFinite(legacyUnitsPerBox) && legacyUnitsPerBox > 0 ? legacyUnitsPerBox : legacyCaseAsBox);
    const boxesPerPallet = Math.max(0, Number(storage.boxesPerPallet) || 0);
    const unitsPerPallet = Math.max(0, Number(storage.unitsPerPallet) || 0);
    const profile = getStorageUnitProfile(storageUnit);
    const defaultPickLevel = profile.pickLevels.includes(storage.defaultPickLevel)
        ? storage.defaultPickLevel
        : (profile.pickLevels[0] || 'box');

    return {
        location: storage.location ?? '',
        storageUnit,
        casePack,
        unitsPerBox,
        boxesPerPallet,
        unitsPerPallet,
        defaultPickLevel,
        maxHeight: Math.max(0, Number(storage.maxHeight) || 0),
        allowOverHang: !!storage.allowOverHang,
        allowStacking: !!storage.allowStacking,
    };
};

const casesPerBox = (storage = {}) => {
    if (storage?.storageUnit !== 'box') return 0;
    const { casePack, unitsPerBox } = normalizeStorage(storage);
    if (!casePack) return 0;
    return unitsPerBox / casePack;
};

const unitsPerPallet = (storage = {}) => {
    const normalized = normalizeStorage(storage);
    if (normalized.storageUnit === 'piece') return normalized.unitsPerPallet;
    if (normalized.storageUnit === 'bale') return 0;
    return normalized.unitsPerBox * normalized.boxesPerPallet;
};

const validateStorage = (storage = {}) => {
    const normalized = normalizeStorage(storage);
    const errors = [];

    if (normalized.storageUnit === 'box') {
        if (normalized.casePack > 0 && normalized.unitsPerBox > 0 && normalized.unitsPerBox < normalized.casePack)
            errors.push('unitsPerBox must be greater than or equal to casePack');
        if (normalized.casePack > 0 && normalized.unitsPerBox > 0 && normalized.unitsPerBox % normalized.casePack !== 0)
            errors.push('unitsPerBox must be a whole multiple of casePack');
    }

    return { normalized, errors };
};

module.exports = {
    normalizeStorage,
    casesPerBox,
    unitsPerPallet,
    validateStorage,
};
