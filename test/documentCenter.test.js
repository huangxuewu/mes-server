const assert = require("node:assert/strict");
const test = require("node:test");
const { createDocumentDocx } = require("../utils/documentDocx");
const { cleanDocumentPage, documentPageToDocx } = require("../utils/documentPage");
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

test("DOCX export uses configurable paper size and editor margins", () => {
    assert.deepEqual(documentPageToDocx(), {
        width: 8.5 * 1440,
        height: 11 * 1440,
        margins: {
            top: 0.75 * 1440,
            right: 0.75 * 1440,
            bottom: 0.75 * 1440,
            left: 0.75 * 1440,
        },
    });
    assert.deepEqual(documentPageToDocx({
        size: "LEGAL",
        margins: { top: 0.5, right: 1, bottom: 1.25, left: 1.5 },
    }), {
        width: 8.5 * 1440,
        height: 14 * 1440,
        margins: { top: 720, right: 1440, bottom: 1800, left: 2160 },
    });
    assert.deepEqual(cleanDocumentPage({
        size: "UNKNOWN",
        margins: { top: -2, right: 9, bottom: "bad", left: 1.125 },
    }), {
        size: "LETTER",
        margins: { top: 0, right: 3, bottom: 0.75, left: 1.13 },
    });
});

test("Dropbox document paths are bounded and filesystem-safe", () => {
    assert.equal(normalizePathPart("QMS / Policy: 001.docx"), "QMS-Policy-001.docx");
    assert.equal(normalizePathPart(""), "file");
    assert.ok(normalizePathPart("x".repeat(200)).length <= 100);
});

test("document files share the id folder regardless of document number", async () => {
    const fs = require("node:fs");
    const vm = require("node:vm");
    const uploads = [];
    const context = {
        module: { exports: {} },
        process: { env: { DROPBOX_CLIENT_ID: "test", DROPBOX_CLIENT_SECRET: "test", DROPBOX_REFRESH_TOKEN: "test" } },
        fetch: () => {},
        require: () => ({ Dropbox: class {
            async filesUpload(input) { uploads.push(input.path); }
            async sharingCreateSharedLinkWithSettings() {
                return { result: { url: "https://www.dropbox.com/test?dl=0" } };
            }
        } }),
    };
    vm.runInNewContext(fs.readFileSync(require.resolve("../utils/documentStorage"), "utf8"), context);
    const upload = context.module.exports.uploadDocumentFile;
    await upload({ documentId: "abc123", documentNumber: "SOP-001", revision: 1, fileName: "cover.png", contents: Buffer.from("image"), category: "thumbnail" });
    await upload({ documentId: "abc123", documentNumber: "SOP-999", revision: 2, fileName: "record.pdf", contents: Buffer.from("pdf") });
    assert.deepEqual(uploads, [
        "/DH MES/document/abc123/revision-1/thumbnail/cover.png",
        "/DH MES/document/abc123/revision-2/attachments/record.pdf",
    ]);
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
