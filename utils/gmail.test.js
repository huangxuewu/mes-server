const test = require("node:test");
const assert = require("node:assert/strict");

const modelsPath = require.resolve("../models");
require.cache[modelsPath] = {
    id: modelsPath,
    filename: modelsPath,
    loaded: true,
    exports: {
        config: {
            find() {
                return {
                    lean: async () => []
                };
            }
        }
    }
};

const gmail = require("./gmail");

test("resolveGmailConfig trims persisted values and applies overrides", () => {
    const docs = [
        { key: "integration.gmail.clientId", value: " client-id " },
        { key: "integration.gmail.clientSecret", value: " client-secret " },
        { key: "integration.gmail.refreshToken", value: " refresh-token " },
        { key: "integration.gmail.redirectUri", value: " https://example.com/callback " }
    ];

    const config = gmail.resolveGmailConfig(docs, {
        clientSecret: " override-secret ",
        refreshToken: " override-refresh "
    });

    assert.deepEqual(config, {
        clientId: "client-id",
        clientSecret: "override-secret",
        refreshToken: "override-refresh",
        redirectUri: "https://example.com/callback"
    });
});

test("resolveGmailOAuthClientConfig only requires OAuth client fields", () => {
    const docs = [
        { key: "integration.gmail.clientId", value: " client-id " },
        { key: "integration.gmail.clientSecret", value: " client-secret " },
        { key: "integration.gmail.redirectUri", value: " https://example.com/callback " }
    ];

    assert.deepEqual(gmail.resolveGmailOAuthClientConfig(docs), {
        clientId: "client-id",
        clientSecret: "client-secret",
        redirectUri: "https://example.com/callback"
    });
});

test("resolveGmailOAuthClientConfig throws when OAuth client fields are missing", () => {
    assert.throws(
        () => gmail.resolveGmailOAuthClientConfig([], { clientId: "ready" }),
        /integration\.gmail\.clientSecret, integration\.gmail\.redirectUri/
    );
});

test("resolveGmailOAuthClientConfig uses localhost redirect URI for local callbacks", () => {
    const docs = [
        { key: "integration.gmail.clientId", value: "client-id" },
        { key: "integration.gmail.clientSecret", value: "client-secret" },
        { key: "integration.gmail.redirectUri", value: "https://example.com/prod" },
        { key: "integration.gmail.redirectUri.dev", value: "http://localhost:3000/oauth2callback" }
    ];

    assert.deepEqual(
        gmail.resolveGmailOAuthClientConfig(docs, {}, { host: "localhost:3000" }),
        {
            clientId: "client-id",
            clientSecret: "client-secret",
            redirectUri: "http://localhost:3000/oauth2callback"
        }
    );
});

test("resolveGmailConfig throws a clear error when required keys are missing", () => {
    assert.throws(
        () => gmail.resolveGmailConfig([], { clientId: "ready" }),
        /integration\.gmail\.clientSecret, integration\.gmail\.refreshToken, integration\.gmail\.redirectUri/
    );
});
