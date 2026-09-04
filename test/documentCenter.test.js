const assert = require("node:assert/strict");
const test = require("node:test");
const { createDocumentDocx } = require("../utils/documentDocx");
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
