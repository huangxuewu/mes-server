// One-off script: obtains a Gmail refresh token for utils/gmail.js.
//
// 1. Create a Google Cloud project, enable the Gmail API, create OAuth
//    credentials (Web) with redirect
//    https://dh-mes-backend-73abf9398712.herokuapp.com/oauth2callback.
// 2. Fill CLIENT_ID / CLIENT_SECRET below (same values as utils/gmail.js).
// 3. Run: node utils/gmailAuthSetup.js
// 4. Sign in with the shipping Gmail account, copy the auth code shown on the
//    callback page, then paste it into this terminal to print the refresh token.

const { google } = require("googleapis");
const readline = require("readline/promises");
const { stdin: input, stdout: output } = require("process");

const CLIENT_ID = "GOOGLE_CLIENT_ID";
const CLIENT_SECRET = "GOOGLE_CLIENT_SECRET";
const REDIRECT_URI = "https://dh-mes-backend-73abf9398712.herokuapp.com/oauth2callback";

const SCOPES = [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.send",
];

const auth = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

const url = auth.generateAuthUrl({ access_type: "offline", prompt: "consent", scope: SCOPES });
console.log("\nOpen this URL in a browser and sign in with the shipping Gmail account:\n");
console.log(url, "\n");

const run = async () => {
    const rl = readline.createInterface({ input, output });

    try {
        const code = (await rl.question("Paste the code shown on the /oauth2callback page: ")).trim();
        if (!code) throw new Error("Missing authorization code");

        const { tokens } = await auth.getToken(code);

        console.log("\nRefresh token (paste into utils/gmail.js REFRESH_TOKEN):\n");
        console.log(tokens.refresh_token, "\n");
    } finally {
        rl.close();
    }
};

run().catch((error) => {
    console.error("\nFailed to exchange auth code:\n", error.message);
    process.exit(1);
});
