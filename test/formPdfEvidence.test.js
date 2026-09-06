const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');
const { createFormPdf } = require('../utils/formPdf');

const pdfjsPath = require.resolve('pdfjs-dist/legacy/build/pdf.mjs', { paths: [require.resolve('pdf-to-img')] });
const normalize = text => text.replace(/\s+/g, '');
const document = { title: 'Inspection evidence', documentNumber: 'FORM-014' };

const inspect = async buffer => {
    const { getDocument } = await import(pathToFileURL(pdfjsPath).href);
    const pdf = await getDocument({ data: new Uint8Array(buffer),
        standardFontDataUrl: path.resolve(path.dirname(pdfjsPath), '../../standard_fonts').split(path.sep).join('/') + '/' }).promise;
    const pages = [];
    try {
        for (let index = 1; index <= pdf.numPages; index++) {
            const page = await pdf.getPage(index);
            const { items } = await page.getTextContent();
            const text = items.map(item => item.str || '').join('\n');
            assert.ok(text.includes(`Page ${index} of ${pdf.numPages}`), 'Every content page has its correct footer');
            const body = items.filter(item => item.str?.trim() && item.transform[5] > 70);
            const footer = items.filter(item => item.str?.trim() && item.transform[5] <= 70).map(item => item.str).join('');
            assert.equal(normalize(footer), normalize(`${document.documentNumber} - Page ${index} of ${pdf.numPages}`), 'Only the footer occupies the footer area');
            assert.ok(body.length, 'No empty or footer-only pages');
            for (const item of items.filter(item => item.str?.trim())) {
                const [,,,, x] = item.transform;
                assert.ok(x >= 47 && x + item.width <= page.view[2] - 47, 'Text stays inside horizontal margins');
            }
            pages.push(body.map(item => item.str).join('\n'));
        }
        return pages;
    } finally {
        await pdf.destroy();
    }
};

for (const [size, orientation] of [['LETTER', 'portrait'], ['A4', 'landscape']]) {
    test(`completed ${size} ${orientation} PDF preserves all long answers and notes across pages`, async () => {
        const observations = Array.from({ length: 45 }, (_, index) => `Finding ${index + 1}: Guard checked and maintenance notified. Restart requires documented supervisor approval.`).join('\n') + '\nEND-OBSERVATIONS';
        const identifier = 'PART'.repeat(480) + 'END-IDENTIFIER';
        const notes = Array.from({ length: 75 }, (_, index) => `Note ${index + 1}: Corrective action and approval recorded.`).join('\n') + '\nEND-NOTES';
        assert.ok(observations.length <= 5000 && identifier.length <= 5000);
        const pages = await inspect(await createFormPdf({ document, revision: 2,
            formSchema: { page: { size, orientation }, fields: [
                { id: 'observations', type: 'textarea', label: 'Observations' },
                { id: 'identifier', type: 'text', label: 'Part identifier' },
                { id: 'disposition', type: 'text', label: 'Disposition' },
            ] }, submission: { entryNumber: 'ENTRY-014', recordedAt: '2026-09-06T12:00:00Z', notes,
                answers: [{ fieldId: 'observations', value: observations }, { fieldId: 'identifier', value: identifier },
                    { fieldId: 'disposition', value: 'FOLLOW-UP-RETAINED' }] } }));
        assert.ok(pages.length > 2, 'Fixture exercises text flowing across multiple pages');
        const text = normalize(pages.join(''));
        for (const value of [observations, identifier, notes, 'Entry notes', 'FOLLOW-UP-RETAINED'])
            assert.ok(text.includes(normalize(value)), 'Complete recorded content is retained');
    });
}

test('short completed forms retain false and zero answers without adding empty notes or blank pages', async () => {
    const pages = await inspect(await createFormPdf({ document, revision: 1,
        formSchema: { fields: [{ id: 'guard', type: 'checkbox', label: 'Guard secure' }, { id: 'count', type: 'number', label: 'Count' }] },
        submission: { entryNumber: 'ENTRY-015', recordedAt: '2026-09-06T12:00:00Z', notes: '',
            answers: [{ fieldId: 'guard', value: false }, { fieldId: 'count', value: 0 }] } }));
    assert.equal(pages.length, 1);
    assert.ok(normalize(pages[0]).includes('GuardsecureNoCount0'));
    assert.equal(pages[0].includes('Entry notes'), false);
});

test('blank forms still show their options and one correctly numbered page', async () => {
    const pages = await inspect(await createFormPdf({ document, revision: 1,
        formSchema: { fields: [{ id: 'shift', type: 'choice', label: 'Shift', options: ['First', 'Second'] },
            { id: 'notes', type: 'textarea', label: 'Observations' }] } }));
    assert.equal(pages.length, 1);
    assert.ok(pages[0].includes('Blank controlled form'));
    assert.ok(normalize(pages[0]).includes('[]First[]Second'));
});
