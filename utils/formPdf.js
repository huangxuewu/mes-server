const PDFDocument = require("pdfkit");

const answerText = (value) => {
    if (value === true) return "Yes";
    if (value === false) return "No";
    if (Array.isArray(value)) return value.join(", ");
    if (value === null || value === undefined) return "";
    return String(value);
};

const createFormPdf = ({
    document,
    revision,
    formSchema,
    relatedDocuments = document.relatedDocuments,
    submission = null,
}) => new Promise((resolve, reject) => {
    const pdf = new PDFDocument({
        size: formSchema?.page?.size || "LETTER",
        layout: formSchema?.page?.orientation || "portrait",
        margins: { top: 48, right: 48, bottom: 80, left: 48 },
        bufferPages: true,
        info: {
            Title: document.title,
            Subject: submission ? `Completed form ${submission.entryNumber}` : `Blank form ${document.documentNumber}`,
        },
    });
    const chunks = [];
    pdf.on("data", (chunk) => chunks.push(chunk));
    pdf.on("end", () => resolve(Buffer.concat(chunks)));
    pdf.on("error", reject);

    const answers = new Map((submission?.answers || []).map((answer) => [answer.fieldId, answer.value]));
    const contentWidth = pdf.page.width - pdf.page.margins.left - pdf.page.margins.right;
    const bottom = () => pdf.page.height - pdf.page.margins.bottom;
    const ensureSpace = (height) => {
        if (pdf.y + height <= bottom()) return;
        pdf.addPage();
    };
    const line = (y = pdf.y) => pdf.moveTo(pdf.page.margins.left, y)
        .lineTo(pdf.page.width - pdf.page.margins.right, y)
        .strokeColor("#d6d6d0")
        .stroke();

    pdf.font("Helvetica-Bold").fontSize(17).fillColor("#20211f").text(document.title);
    pdf.moveDown(0.35);
    pdf.font("Helvetica").fontSize(9).fillColor("#555752").text([
        document.documentNumber,
        `Revision ${revision}`,
        submission?.entryNumber ? `Entry ${submission.entryNumber}` : "Blank controlled form",
    ].filter(Boolean).join("   |   "));

    if (submission) {
        pdf.moveDown(0.35);
        pdf.text([
            `Recorded: ${new Date(submission.recordedAt).toLocaleString("en-US")}`,
            submission.recordedBy && `Completed by: ${submission.recordedBy}`,
            submission.shift && `Shift: ${submission.shift}`,
            submission.paperReference && `Paper reference: ${submission.paperReference}`,
        ].filter(Boolean).join("   |   "));
    }

    const sopLine = (relatedDocuments || [])
        .filter((item) => item.role === "SOP")
        .map((item) => `${item.documentNumber || item.title} Rev ${item.revision || "-"}`)
        .join(", ");
    if (sopLine) {
        pdf.moveDown(0.35);
        pdf.font("Helvetica-Bold").text(`Related SOP: ${sopLine}`);
    }

    pdf.moveDown(0.75);
    line();
    pdf.moveDown(0.8);

    if (formSchema?.instructions) {
        pdf.font("Helvetica").fontSize(9).fillColor("#555752").text(formSchema.instructions);
        pdf.moveDown(0.8);
    }

    for (const field of formSchema?.fields || []) {
        if (field.type === "section") {
            ensureSpace(45);
            pdf.moveDown(0.5);
            pdf.font("Helvetica-Bold").fontSize(12).fillColor("#263b2d").text(field.label || "Section");
            line(pdf.y + 3);
            pdf.moveDown(0.8);
            continue;
        }

        if (field.type === "instruction") {
            ensureSpace(35);
            pdf.font("Helvetica-Oblique").fontSize(9).fillColor("#666862").text(field.label || field.help || "");
            pdf.moveDown(0.7);
            continue;
        }

        ensureSpace(field.type === "textarea" ? 90 : 58);
        const required = field.required ? " *" : "";
        const unit = field.unit ? ` (${field.unit})` : "";
        pdf.font("Helvetica-Bold").fontSize(9).fillColor("#30322f").text(`${field.label || "Untitled field"}${unit}${required}`);
        if (field.help) {
            pdf.moveDown(0.2);
            pdf.font("Helvetica").fontSize(8).fillColor("#777973").text(field.help);
        }

        const value = answerText(answers.get(field.id));
        pdf.moveDown(0.35);
        if (["checkbox", "yesno", "choice"].includes(field.type) && !submission) {
            const choices = field.type === "checkbox"
                ? ["Yes", "No"]
                : field.type === "yesno" ? ["Yes", "No", "N/A"] : field.options || [];
            pdf.font("Helvetica").fontSize(9).fillColor("#30322f").text(choices.map((choice) => `[ ] ${choice}`).join("     "));
        } else if (submission) {
            pdf.font("Helvetica").fontSize(9).fillColor("#20211f").text(value || "-", pdf.page.margins.left, pdf.y, {
                width: contentWidth,
            });
        } else {
            const height = field.type === "textarea" ? 48 : 28;
            pdf.rect(pdf.x, pdf.y, contentWidth, height).strokeColor("#bfc1bb").stroke();
            pdf.y += height;
        }
        pdf.moveDown(0.8);
    }

    if (submission?.notes) {
        ensureSpace(58);
        pdf.font("Helvetica-Bold").fontSize(9).fillColor("#30322f").text("Entry notes");
        pdf.moveDown(0.35);
        pdf.font("Helvetica").fontSize(9).fillColor("#20211f").text(submission.notes, pdf.page.margins.left, pdf.y, {
            width: contentWidth,
        });
    }

    const range = pdf.bufferedPageRange();
    for (let pageIndex = range.start; pageIndex < range.start + range.count; pageIndex += 1) {
        pdf.switchToPage(pageIndex);
        const bodyMargin = pdf.page.margins.bottom;
        // Footer stamping must not trigger the automatic body page break.
        pdf.page.margins.bottom = 0;
        pdf.font("Helvetica").fontSize(8).fillColor("#888a84").text(
            `${document.documentNumber || "Controlled form"}   -   Page ${pageIndex + 1} of ${range.count}`,
            pdf.page.margins.left,
            pdf.page.height - 63,
            { width: contentWidth, align: "center", lineBreak: false },
        );
        pdf.page.margins.bottom = bodyMargin;
    }

    pdf.end();
});

module.exports = { createFormPdf };
