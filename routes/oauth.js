const express = require("express");
const { exchangeGmailAuthCode, saveGmailRefreshToken } = require("../utils/gmail");

const router = express.Router();

const escapeHtml = value => String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const renderPage = ({ title, body, variant = "info", status = 200 }) => {
    const tone = {
        success: { icon: "✓", className: "success" },
        error: { icon: "!", className: "error" },
        warning: { icon: "!", className: "warning" }
    }[variant] || { icon: "i", className: "info" };

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)} · MES Gmail</title>
    <style>
        * { box-sizing: border-box; }
        body {
            margin: 0;
            min-height: 100vh;
            display: grid;
            place-items: center;
            padding: 24px;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            background: #f5f5f7;
            color: #1d1d1f;
        }
        main {
            width: min(100%, 420px);
            padding: 36px 28px;
            text-align: center;
            background: #fff;
            border: 1px solid #e5e5e7;
            border-radius: 14px;
            box-shadow: 0 10px 30px rgba(0, 0, 0, 0.06);
        }
        .icon {
            width: 52px;
            height: 52px;
            margin: 0 auto 18px;
            border-radius: 50%;
            display: grid;
            place-items: center;
            font-size: 24px;
            font-weight: 700;
            line-height: 1;
        }
        .icon.success { color: #1f7a3f; background: #e8f7ed; border: 1px solid #bfe8cb; }
        .icon.error { color: #c93434; background: #fdecec; border: 1px solid #f5c2c2; }
        .icon.warning { color: #9a6700; background: #fff8e8; border: 1px solid #f0d9a8; }
        .icon.info { color: #0e6db9; background: #eef5ff; border: 1px solid #d2e3f3; }
        h1 {
            margin: 0 0 12px;
            font-size: 24px;
            font-weight: 600;
            line-height: 1.25;
        }
        p {
            margin: 0;
            font-size: 15px;
            line-height: 1.55;
            color: #6e6e73;
        }
        p + p { margin-top: 10px; }
        textarea {
            margin-top: 18px;
            width: 100%;
            min-height: 110px;
            padding: 12px;
            border: 1px solid #d2d2d7;
            border-radius: 10px;
            font: 13px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace;
            color: #1d1d1f;
            background: #fafafa;
            resize: vertical;
        }
        small {
            display: block;
            margin-top: 16px;
            font-size: 13px;
            color: #86868b;
        }
    </style>
</head>
<body>
    <main>
        <div class="icon ${tone.className}">${tone.icon}</div>
        <h1>${escapeHtml(title)}</h1>
        ${body}
    </main>
</body>
</html>`;

    return { status, html };
};

const sendPage = (res, page) => res.status(page.status).type("html").send(page.html);

router.get("/oauth2callback", async (req, res) => {
    const { code, error } = req.query;

    if (error) {
        return sendPage(res, renderPage({
            title: "Gmail Authorization Failed",
            variant: "error",
            status: 400,
            body: `<p>${escapeHtml(error)}</p>`
        }));
    }

    if (!code) {
        return sendPage(res, renderPage({
            title: "Missing Authorization Code",
            variant: "warning",
            status: 400,
            body: "<p>Google did not return an authorization code.</p><small>Return to MES and try Authorize again.</small>"
        }));
    }

    try {
        const refreshToken = await exchangeGmailAuthCode(code, {}, { host: req.get("host") });
        await saveGmailRefreshToken(refreshToken);

        return sendPage(res, renderPage({
            title: "Gmail Connected",
            variant: "success",
            body: `
                <p>Your refresh token was saved to MES.</p>
                <small>You can close this tab and return to MES.</small>
            `
        }));
    } catch (authError) {
        return sendPage(res, renderPage({
            title: "Gmail Authorization Failed",
            variant: "error",
            status: 500,
            body: `
                <p>${escapeHtml(authError.message)}</p>
                <p>If needed, copy this code and run <code>node utils/gmailAuthSetup.js</code>.</p>
                <textarea readonly>${escapeHtml(code)}</textarea>
            `
        }));
    }
});

module.exports = router;
