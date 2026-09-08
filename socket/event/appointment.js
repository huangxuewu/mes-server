const db = require("../../models");
const { getClient, sendEmail, getProfileEmail, getGmailAuthUrl } = require("../../utils/gmail");
const { analyzeEmail } = require("../../utils/deepseek");
const { fetchAppointmentAiConfig } = require("../../utils/appointmentAi");
const { normalize, matchCandidate, resolveThreadLoads, mergeLoadAssociations, hydrateThread } = require("../../utils/appointmentFilter");
const { createAppointmentRefreshCoordinator } = require("../../utils/appointmentRefresh");
const { buildSignatureSuffixBySender } = require("../../utils/emailSignature");
const { weighEmail } = require("../../utils/emailWeight");
const { createGmailSyncStep } = require('../../utils/gmailSync');
const { io: serverIo } = require('../io');

const getCandidates = async () => {
    const groups = await db.outbound.getActiveLoads();
    return groups.map(({ loadNumber, loads }) => ({
        loadNumber: normalize(loadNumber),
        proNumber: normalize(loads[0]?.proNumber),
        scac: loads[0]?.carrierSCAC || loads[0]?.executingSCAC || loads[0]?.assignedSCAC || "",
    })).filter(candidate => candidate.loadNumber);
};

const resolveLoadScac = (loadNumber, candidates, fallback = "") => {
    const match = candidates.find(candidate => candidate.loadNumber === normalize(loadNumber));
    return match?.scac || fallback;
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

const associationSignature = associations => JSON.stringify(
    (associations ?? []).map(item => ({
        loadNumber: normalize(item.loadNumber),
        proNumber: normalize(item.proNumber),
        scac: item.scac || "",
        status: item.status || "New",
        proposedTime: item.proposedTime ? new Date(item.proposedTime).toISOString() : null,
    }))
);

const prepareThreads = async (fetched, myEmail, candidates, mailbox) => {
    const storedThreads = await db.emailThread.find({ mailbox,
        ...(fetched.length ? { threadId: { $in: fetched.map(thread => thread.threadId) } } : {}),
    }).lean();
    const existing = storedThreads.map(thread => hydrateThread(thread, candidates));
    const knownIds = new Set(existing.flatMap(t => t.messages.map(m => m.messageId)));
    const associationUpdates = existing
        .filter((thread, index) => associationSignature(thread.loadAssociations) !== associationSignature(storedThreads[index].loadAssociations))
        .map(thread => ({
            updateOne: {
                filter: { _id: thread._id },
                update: { $set: { loadAssociations: thread.loadAssociations } },
            }
        }));
    const aiConfig = fetched.length ? await fetchAppointmentAiConfig() : { useAi: false };
    const writes = [];
    if (associationUpdates.length) writes.push(session => db.emailThread.bulkWrite(associationUpdates, { session }));

    // Stage 1 filter-only when AI off; AI analysis when enabled + API key set
    const { apiKey, provider, useAi } = aiConfig;

    let newMessages = 0;

    for (const thread of fetched) {
        thread.newMessages = thread.messages.filter(message => !knownIds.has(message.messageId));
        const existingThread = existing.find(t => t.threadId === thread.threadId);
        let loadAssociations = mergeLoadAssociations(existingThread, resolveThreadLoads(thread, candidates));
        if (!loadAssociations.length) continue;

        const messages = [];
        const canonical = loadAssociations.find(item => item.loadNumber === normalize(existingThread?.loadNumber)) ?? loadAssociations[0];
        const loadNumber = canonical.loadNumber;
        const proNumber = canonical.proNumber;
        let scac = canonical.scac;
        const latestIntentByLoad = new Map();
        const messageLoads = new Map();
        let previousLoadNumbers = [];

        for (const message of thread.messages ?? []) {
            const explicit = resolveThreadLoads({ subject: message.subject, messages: [message] }, candidates)
                .map(item => item.loadNumber);
            if (explicit.length) previousLoadNumbers = explicit;
            messageLoads.set(message.messageId, explicit.length ? explicit : previousLoadNumbers);
        }

        const signatureContext = [
            ...(existingThread?.messages ?? []),
            ...(thread.messages ?? []),
        ];
        const suffixBySender = buildSignatureSuffixBySender(signatureContext);

        for (const message of thread.newMessages) {
            const isOutgoing = message.from.includes(myEmail);
            // AI reads only the weighted relevant sections; Stage-1 matching keeps the full body
            const { relevantText } = weighEmail(message.body, { from: message.from, candidates, scac, suffixBySender, outgoing: isOutgoing });
            const analysis = await analyzeMessage({ ...message, body: useAi ? relevantText : message.body }, candidates, {
                useAi,
                apiKey,
                provider,
                myEmail,
                subject: thread.subject,
            });

            const inferredLoadNumbers = messageLoads.get(message.messageId) ?? [];
            const analyzedLoadNumber = normalize(analysis.rich?.loadNumber || analysis.loadNumber);
            const loadNumbers = [...new Set([
                ...(analyzedLoadNumber ? [analyzedLoadNumber] : []),
                ...inferredLoadNumbers,
                ...(loadAssociations.length === 1 ? [loadNumber] : []),
            ])].filter(number => loadAssociations.some(item => item.loadNumber === number));

            if (!isOutgoing && analysis.rich)
                loadNumbers.forEach(number => latestIntentByLoad.set(number, analysis.rich.intent));

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
                loadNumbers,
            });
        }

        if (!messages.length) continue;

        scac = resolveLoadScac(loadNumber, candidates, scac);
        loadAssociations = loadAssociations.map(association => ({
            ...association,
            scac: resolveLoadScac(association.loadNumber, candidates, association.scac),
            status: latestIntentByLoad.get(association.loadNumber) === "confirm"
                ? "Confirmed"
                : association.status,
        }));
        newMessages += messages.length;

        const update = {
            $set: {
                loadNumber,
                loadAssociations,
                status: loadAssociations.find(item => item.loadNumber === loadNumber)?.status || existingThread?.status || "New",
            },
            $setOnInsert: { subject: thread.subject },
        };
        if (proNumber) update.$set.proNumber = proNumber;
        if (scac) update.$set.scac = scac;
        writes.push(async session => {
            await db.emailThread.updateOne({ mailbox, threadId: thread.threadId }, update, { upsert: true, session });
            for (const message of messages) {
                await db.emailThread.updateOne({ mailbox, threadId: thread.threadId, 'messages.messageId': { $ne: message.messageId } },
                    { $push: { messages: message } }, { session });
            }
        });
    }

    return { newMessages, apply: async session => { for (const write of writes) await write(session); } };
};

const appointmentRefresh = createAppointmentRefreshCoordinator({ connection: db.config.db,
    executeStep: createGmailSyncStep({ connection: db.config.db, getClient, getCandidates, prepareThreads }),
    notify: payload => serverIo.emit('appointments:sync-status', payload),
});
appointmentRefresh.start();

module.exports = (socket, io) => {
    socket.on("appointments:query", async (payload, callback) => {
        try {
            const { context } = await getClient();
            const [storedThreads, candidates] = await Promise.all([
                db.emailThread.find(context.mailbox ? { $or: [{ mailbox: context.mailbox }, { mailbox: { $exists: false } }] }
                    : { mailbox: { $exists: false } }).sort({ updatedAt: -1 }).lean(),
                getCandidates(),
            ]);
            const threads = storedThreads.map(thread => hydrateThread(thread, candidates));
            callback({ status: "success", message: "Threads fetched successfully", payload: threads });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on("appointments:refresh", async (payload, callback) => {
        try {
            const result = await appointmentRefresh.request({ force: payload?.force === true });
            callback({ status: "success", message: "Mailbox sync status", payload: result });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on('appointments:sync-status', async (_payload, callback) => {
        try {
            callback({ status: 'success', payload: await appointmentRefresh.status() });
        } catch (error) { callback({ status: 'error', message: error.message }); }
    });

    socket.on("appointment:reply", async (payload, callback) => {
        try {
            const { threadId, loadNumber, proNumber, scac, to, subject, body, proposedTime } = payload;
            if (!to) return callback({ status: "error", message: "Missing recipient email" });

            const { context } = await getClient();
            const thread = threadId ? await db.emailThread.findOne({ threadId, mailbox: context.mailbox }) : null;
            const lastMessage = thread?.messages.at(-1);

            const [sent, candidates] = await Promise.all([
                sendEmail({
                    operationId: payload.operationId,
                    threadId: thread?.threadId,
                    to,
                    subject: thread ? `Re: ${thread.subject.replace(/^Re:\s*/i, "")}` : subject,
                    body,
                    inReplyTo: lastMessage?.rfcMessageId || undefined,
                }),
                getCandidates(),
            ]);
            const targetLoadNumber = normalize(loadNumber || thread?.loadNumber);
            const hydrated = thread ? hydrateThread(thread, candidates) : {};
            const loadAssociations = mergeLoadAssociations(hydrated);
            let targetAssociation = loadAssociations.find(item => item.loadNumber === targetLoadNumber);

            if (!targetAssociation && targetLoadNumber) {
                targetAssociation = {
                    loadNumber: targetLoadNumber,
                    proNumber: normalize(proNumber),
                    scac: scac || "",
                    status: "New",
                    proposedTime: null,
                };
                loadAssociations.push(targetAssociation);
            }

            if (targetAssociation && proposedTime) {
                targetAssociation.status = "Time Proposed";
                targetAssociation.proposedTime = new Date(proposedTime);
            }

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
                loadNumbers: targetLoadNumber ? [targetLoadNumber] : [],
            };

            const canonicalLoadNumber = normalize(thread?.loadNumber || targetLoadNumber);
            const canonicalAssociation = loadAssociations.find(item => item.loadNumber === canonicalLoadNumber);

            const update = {
                $set: {
                    loadNumber: canonicalLoadNumber,
                    loadAssociations,
                    ...(proposedTime && canonicalLoadNumber === targetLoadNumber
                        ? { status: "Time Proposed", proposedTime: new Date(proposedTime) }
                        : { status: canonicalAssociation?.status || thread?.status || "New" }),
                },
                $setOnInsert: {
                    subject: sent.subject || subject,
                    ...(proNumber ? { proNumber } : {}),
                    ...(scac ? { scac } : {}),
                },
            };

            await db.emailThread.updateOne({ mailbox: sent.mailbox, threadId: sent.threadId }, update, { upsert: true });
            await db.emailThread.updateOne({ mailbox: sent.mailbox, threadId: sent.threadId, 'messages.messageId': { $ne: sent.messageId } },
                { $push: { messages: message } });
            callback({ status: "success", message: "Email sent successfully" });
        } catch (error) {
            callback({ status: "error", message: error.message,
                payload: { code: error.code || 'GMAIL_SEND_FAILED', nextRetryAt: error.nextRetryAt || null } });
        }
    });

    socket.on("appointment:update", async (payload, callback) => {
        try {
            const { _id, loadNumber, ...update } = payload;
            if (!loadNumber) {
                await db.emailThread.updateOne({ _id }, { $set: update });
                return callback({ status: "success", message: "Thread updated successfully" });
            }

            const [thread, candidates] = await Promise.all([
                db.emailThread.findById(_id).lean(),
                getCandidates(),
            ]);
            if (!thread) return callback({ status: "error", message: "Thread not found" });

            const hydrated = hydrateThread(thread, candidates);
            const loadAssociations = hydrated.loadAssociations;
            let association = loadAssociations.find(item => item.loadNumber === normalize(loadNumber));
            if (!association) {
                association = { loadNumber: normalize(loadNumber), proNumber: "", scac: "", status: "New", proposedTime: null };
                loadAssociations.push(association);
            }

            Object.assign(association, update);
            const set = { loadAssociations };
            if (normalize(thread.loadNumber) === normalize(loadNumber)) Object.assign(set, update);

            await db.emailThread.updateOne({ _id }, { $set: set });
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
