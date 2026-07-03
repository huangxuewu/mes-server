const axios = require("axios");

// NOTE: Stage 1 uses a hard-coded key (same pattern as passcodeCrypto.js).
const MODEL = "deepseek-v4-flash";
const API_KEY = "sk-320546cbcb7946dea0580f177fc2a40d";
const API_URL = "https://api.deepseek.com/chat/completions";

const INTENTS = ["request", "confirm", "change", "eta", "other"];
const TIME_PATTERN = /^([01]\d|2[0-3])[0-5]\d$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const SYSTEM_PROMPT = `You are a logistics email analyst for a warehouse shipping department.
You read one email from a carrier dispatcher and extract appointment facts
about a truck load. You never guess: if a fact is not explicitly stated in
the email, return null for that field. Respond ONLY with a JSON object
matching the schema below — no prose, no markdown.

Schema:
{
  "summary":  one short sentence, format "[SCAC] Sender wants <action> for load <loadNumber> on <date>",
  "rich": {
    "scac":      4-letter carrier SCAC code if present, else null,
    "sender":    first name of the person writing, else null,
    "action":    short verb phrase of what they want, e.g. "to ask appointment time",
    "reference": digits only; the load number OR PRO number the email refers to; must be one of the candidate identifiers provided, else null,
    "date":      "YYYY-MM-DD"; resolve relative dates ("tomorrow", "Friday") against the email sent date provided,
    "time":      4-digit military trucking time like "1400"; normalize "2pm" / "14:00" / "2 o'clock" to "1400"; null if no time stated,
    "intent":    exactly one of "request" | "confirm" | "change" | "eta" | "other"
  }
}

Intent rules:
- "request": asking for or proposing an appointment time
- "confirm": explicitly agreeing to a previously proposed time ("that works", "confirmed for 1400")
- "change":  asking to move an already-set appointment
- "eta":     giving or asking estimated arrival ("driver is 30 min out")
- "other":   anything else (rate requests, spam, unrelated)
Never classify as "confirm" unless agreement is explicit.

Examples:

Email sent Wed 2026-06-03 from "Jeff Miller <jeff@arkafreight.com>", subject "Pickup appt - load 75736164":
"Hi, can we get a pickup time for load 75736164 this Friday? Thanks, Jeff"
Candidates include: load 75736164 / pro 202998812 (ARKA)
->
{"summary":"[ARKA] Jeff wants to ask appointment time for load 75736164 on June 5th","rich":{"scac":"ARKA","sender":"Jeff","action":"to ask appointment time","reference":"75736164","date":"2026-06-05","time":null,"intent":"request"}}

Email sent 2026-06-04 from "dispatch@arkafreight.com", subject "RE: Pickup appt - load 75736164":
"2pm works for us, see you then."
Candidates include: load 75736164 / pro 202998812 (ARKA)
->
{"summary":"[ARKA] Dispatcher confirmed pickup at 1400 for load 75736164","rich":{"scac":"ARKA","sender":null,"action":"confirmed pickup time","reference":"75736164","date":null,"time":"1400","intent":"confirm"}}

Email sent 2026-06-04 from "sales@freightdeals.com", subject "Best LTL rates!":
"We can save you 20% on all lanes, book a call today."
->
{"summary":"Freight rate promotion, not related to a load","rich":{"scac":null,"sender":null,"action":null,"reference":null,"date":null,"time":null,"intent":"other"}}`;

const buildUserMessage = (email, candidates) => `Email:
From: ${email.from}
Subject: ${email.subject}
Sent: ${email.date instanceof Date ? email.date.toISOString() : email.date}

${email.body}

Candidate loads (load number / PRO number / SCAC):
${candidates.map(c => `${c.loadNumber} / ${c.proNumber || "-"} / ${c.scac || "-"}`).join("\n")}`;

const callDeepseek = async (email, candidates) => {
    const { data } = await axios.post(API_URL, {
        model: MODEL,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: buildUserMessage(email, candidates) },
        ],
    }, {
        headers: { Authorization: `Bearer ${API_KEY}` },
        timeout: 60000,
    });

    return JSON.parse(data.choices[0].message.content);
};

// Validate every AI field; anything invalid becomes null rather than stored wrong.
// Resolves reference (load OR pro number) to the canonical load number.
const validate = (result, candidates) => {
    const rich = result?.rich ?? {};
    const reference = String(rich.reference ?? "").trim();
    const match = candidates.find(c => c.loadNumber === reference || (c.proNumber && c.proNumber === reference));

    return {
        summary: String(result?.summary ?? "").trim(),
        rich: {
            scac: rich.scac ? String(rich.scac).trim().toUpperCase() : match?.scac ?? null,
            sender: rich.sender ? String(rich.sender).trim() : null,
            action: rich.action ? String(rich.action).trim() : null,
            loadNumber: match?.loadNumber ?? null,
            date: DATE_PATTERN.test(rich.date) ? rich.date : null,
            time: TIME_PATTERN.test(rich.time) ? rich.time : null,
            intent: INTENTS.includes(rich.intent) ? rich.intent : "other",
        },
        proNumber: match?.proNumber ?? null,
    };
};

// email: { from, subject, date, body }
// candidates: [{ loadNumber, proNumber, scac }]
// Never throws — a total failure degrades to a summary-less "other" so the inbox is not blocked.
const analyzeEmail = async (email, candidates) => {
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            return validate(await callDeepseek(email, candidates), candidates);
        } catch (error) {
            console.error(`DeepSeek analyze failed (attempt ${attempt + 1}):`, error.message);
        }
    }

    return { summary: "", rich: null, proNumber: null };
};

module.exports = { analyzeEmail };
