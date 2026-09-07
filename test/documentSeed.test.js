const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');

const fixture = () => {
    const batches = [];
    const module = { exports: {} };
    const db = { document: {
        updateMany: async () => ({}),
        bulkWrite: (operations, options) => new Promise((resolve, reject) => batches.push({ operations, options, resolve, reject })),
    } };
    vm.runInNewContext(fs.readFileSync(require.resolve('../utils/documentSeed'), 'utf8'), {
        module, require: name => { assert.equal(name, '../models'); return db; },
    });
    return { ...module.exports, batches };
};

test('first starter loads share one batch containing the complete catalog and reuse successful preparation', async () => {
    const seed = fixture();
    const first = seed.prepareDocumentTemplates();
    const second = seed.prepareDocumentTemplates();
    assert.equal(seed.batches.length, 1);
    const { operations, options } = seed.batches[0];
    assert.equal(options.ordered, false);
    const required = seed.requiredTemplateCatalog.reduce((count, [, titles]) => count + titles.length, 0);
    const requiredOperations = operations.filter(({ updateOne }) => updateOne.filter.templateKey.startsWith('required-'));
    assert.equal(requiredOperations.length, required);
    assert.ok(operations.length > required);
    assert.equal(new Set(operations.map(({ updateOne }) => updateOne.filter.templateKey)).size, operations.length);
    for (const { updateOne } of operations) {
        assert.equal(updateOne.upsert, true);
        assert.equal(updateOne.update.$setOnInsert.isTemplate, true);
        assert.equal(updateOne.update.$setOnInsert.contentJson.type, 'doc');
        // Reruns update classification without replacing an existing starter's content.
        assert.deepEqual(Object.keys(updateOne.update.$set), ['documentCategory']);
        for (const key of Object.keys(updateOne.update.$set)) assert.equal(key in updateOne.update.$setOnInsert, false);
    }
    seed.batches[0].resolve({});
    await Promise.all([first, second]);
    await seed.prepareDocumentTemplates();
    assert.equal(seed.batches.length, 1);
});

test('failed starter setup releases the cached request and retries the complete idempotent batch', async () => {
    const seed = fixture();
    const failed = seed.prepareDocumentTemplates();
    seed.batches[0].reject(new Error('Temporary database failure'));
    await assert.rejects(failed, /Temporary database failure/);
    const retry = seed.prepareDocumentTemplates();
    assert.equal(seed.batches.length, 2);
    assert.deepEqual(seed.batches[1].operations.map(op => op.updateOne.filter), seed.batches[0].operations.map(op => op.updateOne.filter));
    seed.batches[1].resolve({});
    await retry;
});
