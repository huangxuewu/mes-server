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

test("resolveGmailConfig throws a clear error when required keys are missing", () => {
    assert.throws(
        () => gmail.resolveGmailConfig([], { clientId: "ready" }),
        /integration\.gmail\.clientSecret, integration\.gmail\.refreshToken, integration\.gmail\.redirectUri/
    );
});
