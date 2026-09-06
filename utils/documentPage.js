const TWIPS_PER_INCH = 1440;

const DOCUMENT_PAGE_SIZES = Object.freeze({
    LETTER: Object.freeze({ label: "Letter", width: 8.5, height: 11 }),
    A4: Object.freeze({ label: "A4", width: 210 / 25.4, height: 297 / 25.4 }),
    LEGAL: Object.freeze({ label: "Legal", width: 8.5, height: 14 }),
});

const DEFAULT_PAGE_MARGIN = 0.75;
const MARGIN_SIDES = ["top", "right", "bottom", "left"];

const cleanMargin = (value) => {
    const margin = Number(value);
    if (!Number.isFinite(margin)) return DEFAULT_PAGE_MARGIN;
    return Math.min(3, Math.max(0, Math.round(margin * 100) / 100));
};

const cleanPageBand = (value = {}) => ({
    enabled: value?.enabled === true,
    hideFirstPage: value?.hideFirstPage === true,
    left: String(value?.left || '').slice(0, 300),
    center: String(value?.center || '').slice(0, 300),
    right: String(value?.right || '').slice(0, 300),
    fontSize: Math.min(14, Math.max(7, Number(value?.fontSize) || 9)),
    color: /^#[a-f\d]{6}$/i.test(value?.color || '') ? value.color : '#606060',
    separator: value?.separator !== false,
    offset: Math.min(1.5, Math.max(0, Number.isFinite(Number(value?.offset)) ? Number(value.offset) : 0.3)),
    height: Math.min(1.5, Math.max(0.25, Number(value?.height) || 0.35)),
});
const cleanPageLogo = value => {
    if (typeof value !== 'string' || value.length > 100000 || !/^data:image\/png;base64,[a-zA-Z0-9+/]+={0,2}$/.test(value)) return '';
    const buffer = Buffer.from(value.split(',')[1], 'base64');
    if (buffer.length < 24 || buffer.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') return '';
    const width = buffer.readUInt32BE(16), height = buffer.readUInt32BE(20);
    return width > 0 && height > 0 && width <= 256 && height <= 256 ? value : '';
};
const cleanDocumentPage = (value = {}) => ({
    companyName: String(value?.companyName || '').slice(0, 200),
    companyLogo: cleanPageLogo(value?.companyLogo),
    header: cleanPageBand(value?.header),
    footer: cleanPageBand(value?.footer),
    size: Object.hasOwn(DOCUMENT_PAGE_SIZES, value?.size) ? value.size : "LETTER",
    margins: Object.fromEntries(MARGIN_SIDES.map((side) => [
        side,
        cleanMargin(value?.margins?.[side]),
    ])),
});

const documentPageToDocx = (value = {}) => {
    const page = cleanDocumentPage(value);
    const size = DOCUMENT_PAGE_SIZES[page.size];
    return {
        width: Math.round(size.width * TWIPS_PER_INCH),
        height: Math.round(size.height * TWIPS_PER_INCH),
        margins: Object.fromEntries(MARGIN_SIDES.map((side) => [
            side,
            Math.round(Math.max(page.margins[side],
                (side === 'top' && page.header.enabled) ? page.header.offset + page.header.height + 0.1 : 0,
                (side === 'bottom' && page.footer.enabled) ? page.footer.offset + page.footer.height + 0.1 : 0) * TWIPS_PER_INCH),
        ])),
    };
};

module.exports = {
    DEFAULT_PAGE_MARGIN,
    DOCUMENT_PAGE_SIZES,
    cleanDocumentPage,
    cleanPageBand,
    documentPageToDocx,
};
