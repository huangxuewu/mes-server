const {
    AlignmentType,
    Document,
    HeadingLevel,
    Packer,
    Paragraph,
    Table,
    TableCell,
    TableRow,
    TextRun,
    WidthType,
} = require("docx");

const textRuns = (node) => {
    if (!node?.content?.length) return [new TextRun("")];
    return node.content.flatMap((child) => {
        if (child.type !== "text") return textRuns(child);
        const marks = child.marks || [];
        const link = marks.find((mark) => mark.type === "link");
        return new TextRun({
            text: child.text || "",
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

const tableFromNode = (node) => new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: (node.content || []).map((row) => new TableRow({
        children: (row.content || []).map((cell) => new TableCell({
            children: (cell.content || []).map((content) => new Paragraph({
                children: textRuns(content),
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
        return [new Paragraph({ heading, alignment: alignment(node), children: textRuns(node) })];
    }
    if (node.type === "blockquote")
        return [new Paragraph({ style: "IntenseQuote", children: [new TextRun(plainText(node))] })];
    if (node.type === "horizontalRule")
        return [new Paragraph({ text: "────────────────────────" })];
    if (node.type === "paragraph")
        return [new Paragraph({ alignment: alignment(node), children: textRuns(node) })];
    return (node.content || []).flatMap((child) => convertNode(child, listLevel));
};

const createDocumentDocx = async (record) => {
    const title = record.title || "Document";
    const metadata = [
        record.documentNumber && `Document: ${record.documentNumber}`,
        `Revision: ${record.revision ?? record.currentRevision ?? 0}`,
        record.effectiveAt && `Effective: ${new Date(record.effectiveAt).toLocaleDateString("en-US")}`,
    ].filter(Boolean).join("   |   ");

    const children = [
        new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun(title)] }),
        new Paragraph({ children: [new TextRun({ text: metadata, color: "666666", size: 18 })] }),
        new Paragraph(""),
        ...(record.contentJson?.content || []).flatMap((node) => convertNode(node)),
    ];

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
            children,
        }],
    });

    return Packer.toBuffer(document);
};

module.exports = {
    createDocumentDocx,
};
