const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

let docs = [];
let requestedKeys = [];
const modelsPath = require.resolve("../models");
require.cache[modelsPath] = {
    id: modelsPath,
    filename: modelsPath,
    loaded: true,
    exports: { config: { find: query => {
        requestedKeys = query.key.$in;
        return { lean: async () => docs };
    } } },
};

const { resolveEdiConfig, EDI_CONFIG_KEYS } = require("../utils/edi/config");
const { buildHeaders, getClient } = require("../utils/edi/client");
const axios = require("axios");
const fields = [
    { key: " X-Tenant-ID ", value: "tenant-123" },
    { key: "AUTHORIZATION", value: "ApiKey custom" },
    { key: "X-Empty", value: "" },
    { key: " ", value: "ignored" },
];

test("server reads header arrays and merges headers without duplicate casing", () => {
    const config = resolveEdiConfig([{ key: EDI_CONFIG_KEYS.customFields, value: fields }]);
    const headers = buildHeaders({ ...config, authToken: "default-token" });
    assert.equal(headers["x-tenant-id"], "tenant-123");
    assert.equal(headers.authorization, "ApiKey custom");
    assert.equal(headers["x-empty"], "");
    assert.equal(headers["content-type"], "application/json");
    assert.equal(headers.AUTHORIZATION, undefined);
    assert.equal(headers[""], undefined);
    assert.equal(buildHeaders({ authToken: "default-token" }).authorization, "Bearer default-token");
    assert.deepEqual(resolveEdiConfig([]).customHeaders, {});
    assert.deepEqual(resolveEdiConfig([{ key: EDI_CONFIG_KEYS.customFields, value: "invalid" }]).customHeaders, {});
});

test("server GraphQL and label requests use current persisted custom headers", async (t) => {
    docs = [{ key: EDI_CONFIG_KEYS.customFields, value: fields }];
    const requests = [];
    t.mock.method(axios, "post", async (url, body, options) => {
        requests.push({ url, options });
        return url.endsWith("/graphql")
            ? { data: { data: { shipments: [] } } }
            : { data: Buffer.from("%PDF-test"), status: 200, headers: { "content-type": "application/pdf" } };
    });
    const client = await getClient();
    assert.ok(requestedKeys.includes(EDI_CONFIG_KEYS.customFields));
    await client.graphql("query { shipments }");
    await client.generateLabels({});
    assert.equal(requests.length, 2);
    for (const { options } of requests) {
        assert.equal(options.headers["x-tenant-id"], "tenant-123");
        assert.equal(options.headers.authorization, "ApiKey custom");
    }
    assert.equal(requests[1].options.headers.accept, "application/pdf, application/json");
    docs = [{ key: EDI_CONFIG_KEYS.customFields, value: [{ key: "X-Tenant-ID", value: "updated" }] }];
    await (await getClient()).graphql("query { shipments }");
    assert.equal(requests[2].options.headers["x-tenant-id"], "updated");
});

test("renderer purchase-order transport applies resolved custom headers", async () => {
    const renderer = path.resolve(__dirname, "../../client/src/renderer/src");
    const configSource = fs.readFileSync(path.join(renderer, "composables/ediConfig.js"), "utf8");
    const orderSource = fs.readFileSync(path.join(renderer, "views/office/production/order/helper/erpPurchaseOrder.js"), "utf8");
    const requests = [];
    const context = vm.createContext({ fetch: async (url, options) => {
        requests.push({ url, options });
        return { ok: true, json: async () => ({ data: {} }) };
    } });
    vm.runInContext(configSource.replace(/export /g, ""), context);
    vm.runInContext(orderSource.replace(/^import .*;\r?\n/gm, "").replace(/export /g, ""), context);
    context.savedConfig = {
        "integration.edi.customFields": fields,
        "integration.edi.authToken": "default-token",
    };
    await vm.runInContext("requestErp(resolveEdiConfig(savedConfig), 'query { po }', {})", context);
    const headers = requests[0].options.headers;
    assert.equal(headers["x-tenant-id"], "tenant-123");
    assert.equal(headers.authorization, "ApiKey custom");
    assert.equal(headers["content-type"], "application/json");
    assert.equal(headers["apollo-require-preflight"], "true");
    context.savedConfig["integration.edi.customFields"] = [];
    await vm.runInContext("requestErp(resolveEdiConfig(savedConfig), 'query { po }', {})", context);
    assert.equal(requests[1].options.headers["x-tenant-id"], undefined);
    assert.equal(requests[1].options.headers.authorization, "Bearer default-token");
});

test("ERP BOL upload uses tenant headers, ERP filename and multipart fields", async t => {
    docs = [{ key: EDI_CONFIG_KEYS.customFields, value: fields }];
    const calls = [];
    t.mock.method(global, "fetch", async (url, options) => {
        calls.push({ url, options });
        return { ok: true, json: async () => ({ result: { name: "123#_456#.pdf" } }) };
    });
    const client = await getClient();
    await client.uploadBol(Buffer.from("%PDF-test"), "123", "456");
    assert.equal(calls[0].options.method, "DELETE");
    assert.deepEqual(JSON.parse(calls[0].options.body), { path: "/BOL/123#_456#.pdf" });
    const { url, options } = calls[1];
    assert.equal(url, "https://erp.downhomeusa.com/api/v1/dropbox/upload");
    assert.equal(options.headers["x-tenant-id"], "tenant-123");
    assert.equal(options.headers.authorization, "ApiKey custom");
    assert.equal(options.headers["content-type"], undefined);
    assert.equal(options.body.get("fileName"), "123#_456#.pdf");
    assert.equal(options.body.get("destinationPath"), "/BOL");
    assert.equal(await options.body.get("file").text(), "%PDF-test");
});

test("ERP BOL authentication failure explains the required token at either file step", async t => {
    docs = [{ key: EDI_CONFIG_KEYS.customFields, value: fields }];
    let failingMethod = 'DELETE';
    const calls = [];
    t.mock.method(global, 'fetch', async (_url, options) => {
        calls.push(options.method);
        return { status: options.method === failingMethod ? 401 : 200, ok: options.method !== failingMethod };
    });
    const client = await getClient();
    await assert.rejects(client.uploadBol(Buffer.from('%PDF-test'), '77737664', '84017970841761576'), /Configure the ERP auth token/);
    assert.deepEqual(calls, ['DELETE']);
    failingMethod = 'POST';
    await assert.rejects(client.uploadBol(Buffer.from('%PDF-test'), '77737664', '84017970841761576'), /Configure the ERP auth token/);
    assert.deepEqual(calls, ['DELETE', 'DELETE', 'POST']);
});
