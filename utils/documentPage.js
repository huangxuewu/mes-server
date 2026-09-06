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

const cleanDocumentPage = (value = {}) => ({
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
            Math.round(page.margins[side] * TWIPS_PER_INCH),
        ])),
    };
};

module.exports = {
    DEFAULT_PAGE_MARGIN,
    DOCUMENT_PAGE_SIZES,
    cleanDocumentPage,
    documentPageToDocx,
};
