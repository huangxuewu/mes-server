// One-off script: obtains a Gmail refresh token and saves it to the config collection.
//
// 1. Import Gmail OAuth settings in MES (Client ID, Client Secret, Redirect URI).
// 2. Run: node utils/gmailAuthSetup.js
// 3. Sign in with the shipping Gmail account in the browser.
// 4. Paste the auth code from /oauth2callback if prompted, or rely on the callback
//    page when the server is running.

const readline = require("readline/promises");
const { stdin: input, stdout: output } = require("process");
const database = require("../config/database");
const { getGmailAuthUrl, exchangeGmailAuthCode, saveGmailRefreshToken } = require("./gmail");

const waitForDb = () => new Promise((resolve, reject) => {
    if (database.connection.readyState === 1) return resolve();
    database.connection.once("connected", resolve);
    database.connection.once("error", reject);
});

const run = async () => {
    await waitForDb();

    const url = await getGmailAuthUrl();
    console.log("\nOpen this URL in a browser and sign in with the shipping Gmail account:\n");
    console.log(url, "\n");

    const rl = readline.createInterface({ input, output });

    try {
        const code = (await rl.question("Paste the code shown on the /oauth2callback page: ")).trim();
        if (!code) throw new Error("Missing authorization code");

        const refreshToken = await exchangeGmailAuthCode(code);
        await saveGmailRefreshToken(refreshToken);

        console.log("\nRefresh token saved to config collection:");
        console.log(`${refreshToken}\n`);
    } finally {
        rl.close();
        await database.connection.close();
    }
};

run().catch((error) => {
    console.error("\nFailed to obtain Gmail refresh token:\n", error.message);
    process.exit(1);
});
