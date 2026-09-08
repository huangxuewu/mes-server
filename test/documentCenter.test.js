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
        companyName: '', companyLogo: '', header: require('../utils/documentPage').cleanPageBand(), footer: require('../utils/documentPage').cleanPageBand(),
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
        "/DocumentCenter/abc123/revision-1/thumbnail/cover.png",
        "/DocumentCenter/abc123/revision-2/attachments/record.pdf",
    ]);
});

test("document thumbnail module loads without the native canvas binding", () => {
    const fs = require("node:fs");
    const vm = require("node:vm");
    const missingBinding = new Error("Cannot find module '../build/Release/canvas.node'");
    const context = {
        module: { exports: {} },
        require: (name) => {
            assert.equal(name, "canvas");
            throw missingBinding;
        },
    };

    vm.runInNewContext(fs.readFileSync(require.resolve("../utils/documentThumbnail"), "utf8"), context);
    assert.equal(typeof context.module.exports.createDocumentThumbnail, "function");
    assert.throws(() => context.module.exports.createDocumentThumbnail({ title: "Test" }), error => error === missingBinding);
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

test('DOCX headers and footers keep saved identity, live page fields, watermark and first-page rules', async () => {
    const {createCanvas}=require('canvas');
    const logo=createCanvas(100,40);logo.getContext('2d').fillRect(0,0,100,40);
    const page={companyName:'Original Company',companyLogo:logo.toDataURL(),margins:{top:0,bottom:0,left:.75,right:.75},
        header:{enabled:true,left:'{companyName}',center:'{documentTitle}',right:'{documentNumber}',height:.5,hideFirstPage:true},
        footer:{enabled:true,left:'Rev. {revision} / {effectiveDate}',center:'Controlled copy',right:'Page {page} of {pages}',height:.5}};
    const buffer=await createDocumentDocx({title:'Original title',documentNumber:'DOC-OLD',revision:2,currentRevision:9,effectiveAt:new Date('2026-08-01T00:00:00Z'),page,watermark:'confidential'});
    const zip=await require('jszip').loadAsync(buffer);
    const xml=await zip.file('word/document.xml').async('string');
    const headers=await Promise.all(Object.values(zip.files).filter(file=>/^word\/header\d+\.xml$/.test(file.name)).map(file=>file.async('string')));
    const footers=await Promise.all(Object.values(zip.files).filter(file=>/^word\/footer\d+\.xml$/.test(file.name)).map(file=>file.async('string')));
    assert.match(xml, /w:titlePg/);
    assert.equal(headers.length,2);
    assert.equal(headers.filter(text=>text.includes('Original Company')).length,1);
    assert.ok(headers.every(text=>text.includes('CONFIDENTIAL')));
    assert.match(headers.join(''), /Original title/);
    assert.match(headers.join(''), /DOC-OLD/);
    assert.match(headers.join(''), /a:blip/);
    assert.equal(footers.length,2);
    assert.ok(footers.every(text=>text.includes('Rev. 2 / 2026-08-01')&&text.includes('NUMPAGES')&&text.includes('>PAGE</w:instrText>')));
    assert.ok(!footers.join('').includes('{pages}'));
    assert.equal(documentPageToDocx(page).margins.top,1296);
    assert.equal(documentPageToDocx(page).margins.bottom,1296);
});

test('repeated DOCX watermarks tile the page while single-line watermarks remain one shape', async () => {
    for (const size of ['LETTER', 'A4', 'LEGAL']) {
        const counts = [];
        for (const layout of ['single', 'repeat']) {
            const buffer = await createDocumentDocx({ title: 'Watermark check', page: { size }, watermark: 'custom', watermarkText: 'Internal use', watermarkLayout: layout });
            const zip = await require('jszip').loadAsync(buffer);
            const header = Object.values(zip.files).find(file => /^word\/header\d+\.xml$/.test(file.name));
            const xml = await header.async('string');
            counts.push((xml.match(/INTERNAL USE/g) || []).length);
        }
        assert.equal(counts[0], 1); assert.ok(counts[1] >= 15);
    }
});

test('document and revision schemas preserve page settings without a database connection', async t => {
    const fs=require('node:fs'),vm=require('node:vm'),mongoose=require('mongoose');
    const connection=mongoose.createConnection();connection.config.autoCreate=false;connection.config.autoIndex=false;
    t.after(()=>connection.destroy());
    for(const name of ['document','documentRevision']){
        const module={exports:{}};
        vm.runInNewContext(fs.readFileSync(require.resolve('../models/'+name),'utf8'),{module,exports:module.exports,Buffer,require:dependency=>{
            if(dependency==='mongoose')return mongoose;
            if(dependency==='../config/database')return connection;
            if(dependency==='../utils/documentPageBandSchema')return require('../utils/documentPageBandSchema');
            throw new Error('Unexpected dependency '+dependency);
        }});
        const record=new module.exports({page:{companyName:'Original company',companyLogo:'data:image/png;base64,eA==',header:{enabled:true,left:'{companyName}',height:.5},footer:{enabled:true,right:'Page {page} of {pages}',hideFirstPage:true}}});
        assert.equal(record.page.validateSync(),undefined);
        const page=record.toObject().page;
        assert.equal(page.header.left,'{companyName}');assert.equal(page.footer.hideFirstPage,true);
        assert.equal(page.companyName,'Original company');assert.equal(page.companyLogo,'data:image/png;base64,eA==');
        record.page.header.height=7;assert.ok(record.page.validateSync());
    }
});

test('page settings reject remote logos and excessive embedded image dimensions',()=>{
    assert.equal(cleanDocumentPage({companyLogo:'https://example.test/logo.png'}).companyLogo,'');
    const canvas=require('canvas').createCanvas(300,100);
    assert.equal(cleanDocumentPage({companyLogo:canvas.toDataURL()}).companyLogo,'');
    const small=require('canvas').createCanvas(100,40).toDataURL();
    assert.equal(cleanDocumentPage({companyLogo:small}).companyLogo,small);
});
