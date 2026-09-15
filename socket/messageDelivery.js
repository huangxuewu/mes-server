const { getActiveSessionUser, getSessionUserId } = require('./session');
const { id, member, projectMessage } = require('../utils/messagePolicy');
const { Types: { ObjectId } } = require('mongoose');
const projectTopics = async (topics, userId) => {
    if (!topics.length) return [];
    const db = require('../models');
    const reads = await db.messageRead.find({ topicId: { $in: topics.map(topic => topic._id) }, userId },
        { topicId: 1, readAt: 1, messageId: 1 }).lean();
    const readsByTopic = new Map(reads.map(read => [id(read.topicId), read]));
    const unread = await db.message.aggregate([
        { $match: { authorId: { $ne: new ObjectId(id(userId)) }, status: { $nin: ['Deleted', 'Retracted'] },
            $or: topics.map(topic => {
                const read = readsByTopic.get(id(topic));
                return { topicId: new ObjectId(id(topic)), ...(read?.readAt ? { $or: [
                    { createdAt: { $gt: read.readAt } },
                    { createdAt: read.readAt, _id: { $gt: read.messageId } },
                ] } : {}) };
            }),
        } },
        { $group: { _id: '$topicId', count: { $sum: 1 } } },
    ]);
    const counts = new Map(unread.map(row => [id(row._id), row.count]));
    return topics.map(topic => {
        const { requestHash, clientRequestId, ...safe } = topic.toObject ? topic.toObject() : topic;
        return { ...safe, unreadCount: counts.get(id(topic)) || 0 };
    });
};
const projectTopic = async (topic, userId) => (await projectTopics([topic], userId))[0];
const deliverTopicChange = async (io, topic) => {
    const projections = new Map();
    const participantIds = new Set(topic.participants.map(id));
    await Promise.all([...io.sockets.sockets.values()].map(async socket => {
        if (!getSessionUserId(socket)) return;
        if (!participantIds.has(getSessionUserId(socket)) && !socket.data.messageTopics?.has(id(topic))) return;
        try {
            const user = await getActiveSessionUser(socket);
            const generation = socket.data.sessionGeneration;
            const currentTopic = await require('../models').topic.findById(topic._id).lean();
            if (getSessionUserId(socket) !== id(user) || socket.data.sessionGeneration !== generation) return;
            if (!member(currentTopic, user._id)) {
                if (socket.data.messageTopics?.has(id(topic))) socket.emit('topic:delete', id(topic));
                socket.data.messageTopics?.delete(id(topic));
                return;
            }
            if (!projections.has(id(user))) projections.set(id(user), projectTopic(currentTopic, user._id));
            const safe = await projections.get(id(user));
            const allowed = await require('../models').topic.exists({ _id: topic._id, participants: user._id, isDeleted: { $ne: true } });
            if (!allowed || getSessionUserId(socket) !== id(user) || socket.data.sessionGeneration !== generation || socket.data.expiresAt <= Date.now()) return;
            (socket.data.messageTopics ||= new Set()).add(id(topic));
            socket.emit('topic:update', safe);
        } catch { /* Invalid sessions receive no protected data. */ }
    }));
};
const deliverMessageChange = async (io, message) => {
    const topic = await require('../models').topic.findById(message.topicId).lean();
    if (!topic || topic.isDeleted) return;
    const participantIds = new Set(topic.participants.map(id));
    await Promise.all([...io.sockets.sockets.values()].map(async socket => {
        if (!getSessionUserId(socket)) return;
        if (!participantIds.has(getSessionUserId(socket))) return;
        try {
            const user = await getActiveSessionUser(socket);
            const generation = socket.data.sessionGeneration;
            const allowed = await require('../models').topic.exists({ _id: topic._id, participants: user._id, isDeleted: { $ne: true } });
            if (allowed && getSessionUserId(socket) === id(user) && socket.data.sessionGeneration === generation && socket.data.expiresAt > Date.now()) socket.emit('message:update', projectMessage(message));
        } catch { /* Invalid sessions receive no protected data. */ }
    }));
};
module.exports = { projectTopic, projectTopics, deliverTopicChange, deliverMessageChange };
