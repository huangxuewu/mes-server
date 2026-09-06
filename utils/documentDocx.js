const {
    AlignmentType,
    Document,
    Header,
    Footer,
    PageNumber,
    BorderStyle,
    TableBorders,
    TableLayoutType,
    VerticalAlign,
    ImageRun,
    HeadingLevel,
    HorizontalPositionAlign,
    HorizontalPositionRelativeFrom,
    Packer,
    PageOrientation,
    Paragraph,
    Table,
    TableCell,
    TableRow,
    TextRun,
    TextWrappingType,
    VerticalAnchor,
    VerticalPositionAlign,
    VerticalPositionRelativeFrom,
    WidthType,
    WpsShapeRun,
} = require("docx");
const { cleanDocumentPage, documentPageToDocx } = require("./documentPage");

const PROFESSIONAL_FONTS = new Set([
    "Roboto",
    "Roboto Condensed",
    "Roboto Slab",
    "Roboto Mono",
    "Calibri",
    "Arial",
    "Georgia",
    "Times New Roman",
]);

const docxFontSize = (value) => {
    const points = Number.parseFloat(String(value || ""));
    return Number.isFinite(points) && points >= 6 && points <= 72
        ? Math.round(points * 2)
        : undefined;
};

const textRuns = (node) => {
    if (!node?.content?.length) return [new TextRun("")];
    return node.content.flatMap((child) => {
        if (child.type !== "text") return textRuns(child);
        const marks = child.marks || [];
        const link = marks.find((mark) => mark.type === "link");
        const typography = marks.find((mark) => mark.type === "typographyStyle")?.attrs || {};
        return new TextRun({
            text: child.text || "",
            font: PROFESSIONAL_FONTS.has(typography.fontFamily) ? typography.fontFamily : undefined,
            size: docxFontSize(typography.fontSize),
            bold: marks.some((mark) => mark.type === "bold"),
            italics: marks.some((mark) => mark.type === "italic"),
            strike: marks.some((mark) => mark.type === "strike"),
            underline: marks.some((mark) => mark.type === "underline") ? {} : undefined,
            highlight: marks.some((mark) => mark.type === "highlight") ? "yellow" : undefined,
            style: link ? "Hyperlink" : undefined,
        });
    });
};

const plainText = (node) => {
    if (node?.type === "text") return node.text || "";
    return (node?.content || []).map(plainText).join(" ");
};

const alignment = (node) => ({
    center: AlignmentType.CENTER,
    right: AlignmentType.RIGHT,
    justify: AlignmentType.JUSTIFIED,
}[node?.attrs?.textAlign] || AlignmentType.LEFT);

const lineSpacing = (node) => {
    const lineHeight = Number(node?.attrs?.lineHeight);
    return Number.isFinite(lineHeight) && lineHeight >= 0.8 && lineHeight <= 3
        ? { line: Math.round(lineHeight * 240) }
        : undefined;
};

const tableFromNode = (node) => new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: (node.content || []).map((row) => new TableRow({
        children: (row.content || []).map((cell) => new TableCell({
            children: (cell.content || []).map((content) => new Paragraph({
                children: textRuns(content),
                spacing: lineSpacing(content),
            })),
        })),
    })),
});

const convertNode = (node, listLevel = 0) => {
    if (!node) return [];
    if (node.type === "table") return [tableFromNode(node)];
    if (node.type === "bulletList" || node.type === "orderedList")
        return (node.content || []).flatMap((item, index) => {
            const body = item.content?.[0] || item;
            return [
                new Paragraph({
                    children: textRuns(body),
                    spacing: lineSpacing(body),
                    bullet: node.type === "bulletList" ? { level: listLevel } : undefined,
                    numbering: node.type === "orderedList" ? { reference: "document-numbering", level: listLevel } : undefined,
                }),
                ...(item.content || []).slice(1).flatMap((child) => convertNode(child, listLevel + 1)),
            ];
        });
    if (node.type === "heading") {
        const heading = {
            1: HeadingLevel.HEADING_1,
            2: HeadingLevel.HEADING_2,
            3: HeadingLevel.HEADING_3,
        }[node.attrs?.level] || HeadingLevel.HEADING_2;
        return [new Paragraph({
            heading,
            alignment: alignment(node),
            spacing: lineSpacing(node),
            children: textRuns(node),
        })];
    }
    if (node.type === "blockquote")
        return [new Paragraph({
            style: "IntenseQuote",
            spacing: lineSpacing(node),
            children: [new TextRun(plainText(node))],
        })];
    if (node.type === "horizontalRule")
        return [new Paragraph({ text: "────────────────────────" })];
    if (node.type === "paragraph")
        return [new Paragraph({
            alignment: alignment(node),
            spacing: lineSpacing(node),
            children: textRuns(node),
        })];
    return (node.content || []).flatMap((child) => convertNode(child, listLevel));
};

const createWatermarkParagraph = (record) => {
    const text = String(record.watermarkText
        || (record.watermark === "confidential" ? "CONFIDENTIAL" : ""))
        .trim()
        .slice(0, 120);
    if (!text) return null;

    return new Paragraph({
            spacing: { before: 0, after: 0, line: 1, lineRule: 'exact' },
            children: [new WpsShapeRun({
                type: "wps",
                transformation: {
                    width: 640,
                    height: 110,
                    rotation: -32,
                },
                floating: {
                    horizontalPosition: {
                        relative: HorizontalPositionRelativeFrom.PAGE,
                        align: HorizontalPositionAlign.CENTER,
                    },
                    verticalPosition: {
                        relative: VerticalPositionRelativeFrom.PAGE,
                        align: VerticalPositionAlign.CENTER,
                    },
                    behindDocument: true,
                    allowOverlap: true,
                    wrap: { type: TextWrappingType.NONE },
                },
                nonVisualProperties: { txBox: "1" },
                bodyProperties: {
                    verticalAnchor: VerticalAnchor.CENTER,
                    margins: { top: 0, right: 0, bottom: 0, left: 0 },
                },
                children: [new Paragraph({
                    alignment: AlignmentType.CENTER,
                    children: [new TextRun({
                        text: text.toUpperCase(),
                        bold: true,
                        color: "D7DAD5",
                        size: text.length > 30 ? 42 : 58,
                    })],
                })],
            })],
    });
};

const createPageBand = (record, band, kind, width, logo) => {
    const effectiveDate = record.effectiveAt ? new Date(record.effectiveAt).toISOString().slice(0, 10) : '';
    const values = { companyName: record.page?.companyName || '', documentTitle: record.title || '',
        documentNumber: record.documentNumber || '', revision: record.revision ?? record.currentRevision ?? '', effectiveDate };
    const border = { style: BorderStyle.SINGLE, size: 4, color: band.color.slice(1) };
    const columns = ['left', 'center', 'right'].map(slot => band[slot].replace(/\{(companyName|documentTitle|documentNumber|revision|effectiveDate)\}/g, (_, key) => String(values[key])));
    // Word flows its own pages. Keep page fields live, and fit long labels into the reserved area.
    const columnPoints = width / 20 / 3 - 12;
    const rows = Math.max(1, ...columns.map(text => text.split('\n').reduce((count, line) => count + Math.max(1, Math.ceil(line.length * band.fontSize * 0.6 / columnPoints)), 0)));
    const fontSize = Math.min(band.fontSize, Math.max(2, (band.height * 72 - 6) / (rows * 1.2)));
    return new Table({
        width: { size: width, type: WidthType.DXA },
        columnWidths: [width / 3, width / 3, width / 3].map(Math.round),
        layout: TableLayoutType.FIXED,
        borders: { ...TableBorders.NONE, ...(band.separator ? { [kind === 'header' ? 'bottom' : 'top']: border } : {}) },
        margins: { top: 30, bottom: 30, left: 0, right: 0 },
        rows: [new TableRow({
            height: { value: Math.round(band.height * 1440), rule: 'atLeast' },
            children: columns.map((text, index) => new TableCell({
                width: { size: Math.round(width / 3), type: WidthType.DXA },
                verticalAlign: VerticalAlign.CENTER,
                children: text.split('\n').map((line, lineIndex) => new Paragraph({
                    alignment: [AlignmentType.LEFT, AlignmentType.CENTER, AlignmentType.RIGHT][index],
                    spacing: { before: 0, after: 0, line: Math.round(fontSize * 24), lineRule: 'exact' },
                    children: [
                        ...(logo && kind === 'header' && index === 0 && lineIndex === 0 ? [new ImageRun({
                            type: 'png', data: logo.data,
                            transformation: { width: logo.width, height: logo.height },
                        }), new TextRun(' ')] : []),
                        ...line.split(/(\{page\}|\{pages\})/).filter(Boolean).map(part => new TextRun({
                        font: 'Arial', size: Math.round(fontSize * 2), color: band.color.slice(1),
                        ...(part === '{page}' || part === '{pages}'
                            ? { children: [part === '{page}' ? PageNumber.CURRENT : PageNumber.TOTAL_PAGES] } : { text: part }),
                    })),
                    ],
                })),
            })),
        })],
    });
};

const createDocumentDocx = async (record) => {
    const title = record.title || "Document";
    const metadata = [
        record.documentNumber && `Document: ${record.documentNumber}`,
        record.documentCategory && `Category: ${record.documentCategory}`,
        `Revision: ${record.revision ?? record.currentRevision ?? 0}`,
        record.effectiveAt && `Effective: ${new Date(record.effectiveAt).toLocaleDateString("en-US")}`,
    ].filter(Boolean).join("   |   ");

    const children = [
        new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun(title)] }),
        new Paragraph({ children: [new TextRun({ text: metadata, color: "666666", size: 18 })] }),
        new Paragraph(""),
        ...(record.contentJson?.content || []).flatMap((node) => convertNode(node)),
    ];
    const settings = cleanDocumentPage(record.page);
    const page = documentPageToDocx(record.page);
    let logo = null;
    if (settings.header.enabled && settings.companyLogo) {
        try {
            const data = Buffer.from(settings.companyLogo.split(',')[1], 'base64');
            const image = await require('canvas').loadImage(data);
            const fit = Math.min((page.width - page.margins.left - page.margins.right) / 15 / 3 * 0.4 / image.width,
                Math.max(1, settings.header.height * 96 - 10) / image.height);
            logo = { data, width: image.width * fit, height: image.height * fit };
        } catch { /* A malformed legacy logo must not prevent exporting the document. */ }
    }
    const titlePage = (settings.header.enabled && settings.header.hideFirstPage) || (settings.footer.enabled && settings.footer.hideFirstPage);
    const bandChildren = (kind, first = false) => {
        const band = settings[kind];
        const watermark = kind === 'header' ? createWatermarkParagraph(record) : null;
        return [watermark, band.enabled && !(first && band.hideFirstPage)
            ? createPageBand(record, band, kind, page.width - page.margins.left - page.margins.right, logo) : null].filter(Boolean);
    };
    const headerChildren = bandChildren('header');
    const footerChildren = bandChildren('footer');

    const document = new Document({
        numbering: {
            config: [{
                reference: "document-numbering",
                levels: [{
                    level: 0,
                    format: "decimal",
                    text: "%1.",
                    alignment: AlignmentType.START,
                }],
            }],
        },
        sections: [{
            properties: {
                titlePage,
                page: {
                    size: {
                        width: page.width,
                        height: page.height,
                        orientation: PageOrientation.PORTRAIT,
                    },
                    margin: {
                        ...page.margins,
                        header: Math.round(settings.header.offset * 1440),
                        footer: Math.round(settings.footer.offset * 1440),
                        gutter: 0,
                    },
                },
            },
            headers: headerChildren.length ? { default: new Header({ children: headerChildren }),
                ...(titlePage ? { first: new Header({ children: bandChildren('header', true) }) } : {}) } : undefined,
            footers: footerChildren.length ? { default: new Footer({ children: footerChildren }),
                ...(titlePage ? { first: new Footer({ children: bandChildren('footer', true) }) } : {}) } : undefined,
            children,
        }],
    });

    return Packer.toBuffer(document);
};

module.exports = {
    createDocumentDocx,
};
