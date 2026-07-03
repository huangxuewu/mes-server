const db = require("../../models");
const { fetchThreads, sendEmail, getProfileEmail } = require("../../utils/gmail");
const { analyzeEmail } = require("../../utils/deepseek");

const getCandidates = async () => {
    const groups = await db.outbound.getActiveLoads();
    return groups.map(({ loadNumber, loads }) => ({
        loadNumber,
        proNumber: loads[0]?.proNumber || "",
        scac: loads[0]?.carrierSCAC || loads[0]?.executingSCAC || loads[0]?.assignedSCAC || "",
    }));
};

// Regex fallback when the AI could not resolve a load: match any candidate identifier in the text
const matchCandidate = (text, candidates) =>
    candidates.find(c => text.includes(c.loadNumber) || (c.proNumber && text.includes(c.proNumber)));

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

            const [fetched, candidates, myEmail] = await Promise.all([
                fetchThreads(knownIds),
                getCandidates(),
                getProfileEmail(),
            ]);

            let newMessages = 0;

            for (const thread of fetched) {
                const existingThread = existing.find(t => t.threadId === thread.threadId);
                const messages = [];
                let loadNumber = existingThread?.loadNumber || "";
                let proNumber = "";
                let scac = "";
                let latestIntent = null;

                for (const message of thread.newMessages) {
                    const isOutgoing = message.from.includes(myEmail);
                    const analysis = isOutgoing
                        ? { summary: "", rich: null, proNumber: null }
                        : await analyzeEmail(message, candidates);

                    if (analysis.rich?.loadNumber) {
                        loadNumber = analysis.rich.loadNumber;
                        proNumber = analysis.proNumber || proNumber;
                        scac = analysis.rich.scac || scac;
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

                // Fallback: match load/pro number directly in subject or bodies
                if (!loadNumber) {
                    const match = matchCandidate(`${thread.subject} ${messages.map(m => m.body).join(" ")}`, candidates);
                    if (match) {
                        loadNumber = match.loadNumber;
                        proNumber = match.proNumber;
                        scac = scac || match.scac;
                    }
                }

                // Threads that cannot be tied to any load are not persisted
                if (!loadNumber) continue;

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
};
