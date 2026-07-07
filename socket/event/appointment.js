const db = require("../../models");
const { fetchThreads, sendEmail, getProfileEmail, getGmailAuthUrl } = require("../../utils/gmail");
const { analyzeEmail } = require("../../utils/deepseek");
const { fetchAppointmentAiConfig } = require("../../utils/appointmentAi");
const { normalize, matchCandidate, resolveThreadLoad } = require("../../utils/appointmentFilter");

const getCandidates = async () => {
    const groups = await db.outbound.getActiveLoads();
    return groups.map(({ loadNumber, loads }) => ({
        loadNumber: normalize(loadNumber),
        proNumber: normalize(loads[0]?.proNumber),
        scac: loads[0]?.carrierSCAC || loads[0]?.executingSCAC || loads[0]?.assignedSCAC || "",
    })).filter(candidate => candidate.loadNumber);
};

const analyzeMessage = async (message, candidates, { useAi, apiKey, provider, myEmail, subject }) => {
    if (message.from.includes(myEmail)) return { summary: "", rich: null, proNumber: null, loadNumber: null, scac: null };

    if (!useAi) {
        const match = matchCandidate(`${message.subject || subject || ""} ${message.body}`, candidates);
        return {
            summary: "",
            rich: null,
            proNumber: match?.proNumber ?? null,
            loadNumber: match?.loadNumber ?? null,
            scac: match?.scac ?? null,
        };
    }

    return analyzeEmail(message, candidates, { apiKey, provider });
};

module.exports = (socket, io) => {
    socket.on("appointments:query", async (payload, callback) => {
        try {
            const threads = await db.emailThread.find({}).sort({ updatedAt: -1 });
            callback({ status: "success", message: "Threads fetched successfully", payload: threads });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on("appointments:refresh", async (payload, callback) => {
        try {
            const existing = await db.emailThread.find({}, { threadId: 1, loadNumber: 1, "messages.messageId": 1 });
            const knownIds = new Set(existing.flatMap(t => t.messages.map(m => m.messageId)));

            const [fetched, candidates, myEmail, aiConfig] = await Promise.all([
                fetchThreads(knownIds),
                getCandidates(),
                getProfileEmail(),
                fetchAppointmentAiConfig(),
            ]);

            // Stage 1 filter-only when AI off; AI analysis when enabled + API key set
            const { apiKey, provider, useAi } = aiConfig;

            let newMessages = 0;

            for (const thread of fetched) {
                const existingThread = existing.find(t => t.threadId === thread.threadId);
                const messages = [];
                let loadNumber = normalize(existingThread?.loadNumber);
                let proNumber = normalize(existingThread?.proNumber);
                let scac = existingThread?.scac || "";
                let latestIntent = null;

                for (const message of thread.newMessages) {
                    const isOutgoing = message.from.includes(myEmail);
                    const analysis = await analyzeMessage(message, candidates, {
                        useAi,
                        apiKey,
                        provider,
                        myEmail,
                        subject: thread.subject,
                    });

                    if (useAi && analysis.rich?.loadNumber) {
                        loadNumber = normalize(analysis.rich.loadNumber);
                        proNumber = normalize(analysis.proNumber) || proNumber;
                        scac = analysis.rich.scac || scac;
                    } else if (!useAi && analysis.loadNumber) {
                        loadNumber = normalize(analysis.loadNumber);
                        proNumber = normalize(analysis.proNumber) || proNumber;
                        scac = analysis.scac || scac;
                    }

                    if (!isOutgoing && analysis.rich) latestIntent = analysis.rich.intent;

                    messages.push({
                        messageId: message.messageId,
                        rfcMessageId: message.rfcMessageId,
                        from: message.from,
                        to: message.to,
                        date: message.date,
                        body: message.body,
                        summary: analysis.summary,
                        rich: analysis.rich,
                        isOutgoing,
                    });
                }

                if (!loadNumber) {
                    const resolved = resolveThreadLoad(thread, candidates);
                    if (resolved) {
                        loadNumber = resolved.loadNumber;
                        proNumber = resolved.proNumber || proNumber;
                        scac = scac || resolved.scac;
                    }
                }

                // Threads that cannot be tied to any load are not persisted
                if (!loadNumber || !messages.length) continue;

                newMessages += messages.length;

                const update = {
                    $push: { messages: { $each: messages } },
                    $set: { loadNumber },
                    $setOnInsert: { subject: thread.subject },
                };
                if (proNumber) update.$set.proNumber = proNumber;
                if (scac) update.$set.scac = scac;
                if (latestIntent === "confirm") update.$set.status = "Confirmed";

                await db.emailThread.updateOne({ threadId: thread.threadId }, update, { upsert: true });
            }

            const threads = await db.emailThread.find({}).sort({ updatedAt: -1 });
            callback({ status: "success", message: "Mailbox refreshed", payload: { newMessages, threads } });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on("appointment:reply", async (payload, callback) => {
        try {
            const { threadId, loadNumber, proNumber, scac, to, subject, body, proposedTime } = payload;
            if (!to) return callback({ status: "error", message: "Missing recipient email" });

            const thread = threadId ? await db.emailThread.findOne({ threadId }) : null;
            const lastMessage = thread?.messages.at(-1);

            const sent = await sendEmail({
                threadId: thread?.threadId,
                to,
                subject: thread ? `Re: ${thread.subject.replace(/^Re:\s*/i, "")}` : subject,
                body,
                inReplyTo: lastMessage?.rfcMessageId || undefined,
            });

            const message = {
                messageId: sent.messageId,
                rfcMessageId: sent.rfcMessageId,
                from: sent.from,
                to: sent.to,
                date: sent.date,
                body,
                summary: "",
                rich: null,
                isOutgoing: true,
            };

            const update = {
                $push: { messages: message },
                $set: {
                    loadNumber: thread?.loadNumber || loadNumber || "",
                    ...(proposedTime ? { status: "Time Proposed", proposedTime: new Date(proposedTime) } : {}),
                },
                $setOnInsert: {
                    subject: sent.subject || subject,
                    ...(proNumber ? { proNumber } : {}),
                    ...(scac ? { scac } : {}),
                },
            };

            await db.emailThread.updateOne({ threadId: sent.threadId }, update, { upsert: true });
            callback({ status: "success", message: "Email sent successfully" });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on("appointment:update", async (payload, callback) => {
        try {
            const { _id, ...update } = payload;
            await db.emailThread.updateOne({ _id }, { $set: update });
            callback({ status: "success", message: "Thread updated successfully" });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on("appointment:config:test", async (payload, callback) => {
        try {
            const emailAddress = await getProfileEmail(payload);
            callback({
                status: "success",
                message: "Gmail configuration is valid",
                payload: { emailAddress }
            });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on("appointment:config:auth-url", async (payload, callback) => {
        try {
            const url = await getGmailAuthUrl(payload);
            callback({
                status: "success",
                message: "Gmail authorization URL created",
                payload: { url }
            });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });
};
