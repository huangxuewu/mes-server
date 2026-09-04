const {
    AlignmentType,
    Document,
    Header,
    HeadingLevel,
    HorizontalPositionAlign,
    HorizontalPositionRelativeFrom,
    Packer,
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

const createWatermarkHeader = (record) => {
    const text = String(record.watermarkText
        || (record.watermark === "confidential" ? "CONFIDENTIAL" : ""))
        .trim()
        .slice(0, 120);
    if (!text) return null;

    return new Header({
        children: [new Paragraph({
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
    const watermarkHeader = createWatermarkHeader(record);

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
            properties: {},
            headers: watermarkHeader ? { default: watermarkHeader } : undefined,
            children,
        }],
    });

    return Packer.toBuffer(document);
};

module.exports = {
    createDocumentDocx,
};
