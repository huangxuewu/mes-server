const assert = require("node:assert/strict");
const test = require("node:test");
const { createDocumentDocx } = require("../utils/documentDocx");
const { createFormPdf } = require("../utils/formPdf");
const { normalizePathPart } = require("../utils/documentStorage");
const { createDocumentThumbnail } = require("../utils/documentThumbnail");

test("DOCX export creates a valid Word package from editor JSON", async () => {
    const buffer = await createDocumentDocx({
        title: "Quality Policy",
        documentNumber: "QMS-POL-001",
        revision: 2,
        contentJson: {
            type: "doc",
            content: [
                {
                    type: "heading",
                    attrs: { level: 1 },
                    content: [{ type: "text", text: "Purpose" }],
                },
                {
                    type: "paragraph",
                    content: [{
                        type: "text",
                        text: "Make conforming product.",
                        marks: [{ type: "bold" }],
                    }],
                },
            ],
        },
    });

    assert.ok(Buffer.isBuffer(buffer));
    assert.ok(buffer.length > 500);
    assert.equal(buffer.subarray(0, 2).toString(), "PK");
});

test("Dropbox document paths are bounded and filesystem-safe", () => {
    assert.equal(normalizePathPart("QMS / Policy: 001.docx"), "QMS-Policy-001.docx");
    assert.equal(normalizePathPart(""), "file");
    assert.ok(normalizePathPart("x".repeat(200)).length <= 100);
});

test("document thumbnail generator returns a PNG cover", () => {
    const buffer = createDocumentThumbnail({
        title: "Document and Record Control",
        documentNumber: "QMS-POL-002",
        revision: 3,
    });
    assert.ok(buffer.length > 1000);
    assert.equal(buffer.subarray(1, 4).toString(), "PNG");
});

test("DOCX export supports a document watermark", async () => {
    const buffer = await createDocumentDocx({
        title: "Internal Procedure",
        watermark: "confidential",
        watermarkText: "CONFIDENTIAL",
        contentJson: {
            type: "doc",
            content: [{ type: "paragraph", content: [{ type: "text", text: "Internal use only." }] }],
        },
    });

    assert.ok(Buffer.isBuffer(buffer));
    assert.ok(buffer.length > 500);
    assert.equal(buffer.subarray(0, 2).toString(), "PK");
});

test("form generator creates a printable PDF from a form definition", async () => {
    const buffer = await createFormPdf({
        document: {
            title: "Line Clearance Check",
            documentNumber: "QMS-FRM-001",
            relatedDocuments: [{
                title: "Line Clearance SOP",
                documentNumber: "QMS-SOP-004",
                revision: 2,
            }],
        },
        revision: 1,
        formSchema: {
            instructions: "Complete before production starts.",
            page: { size: "LETTER", orientation: "portrait" },
            fields: [
                { id: "section-1", type: "section", label: "Verification" },
                { id: "line", type: "text", label: "Production line", required: true },
                { id: "clean", type: "yesno", label: "Previous materials removed", required: true },
                { id: "initials", type: "signature", label: "Verified by" },
            ],
        },
    });

    assert.ok(Buffer.isBuffer(buffer));
    assert.ok(buffer.length > 1000);
    assert.equal(buffer.subarray(0, 4).toString(), "%PDF");
    assert.equal(buffer.toString("latin1").match(/\/Type \/Page\b/g)?.length, 1);
});
