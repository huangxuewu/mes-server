const { getActiveSessionUser, getSessionUserId } = require('./session');
const { id, member, projectMessage } = require('../utils/messagePolicy');
const projectTopic = async (topic, userId) => {
    const db = require('../models');
    const { requestHash, clientRequestId, ...safe } = topic.toObject ? topic.toObject() : topic;
    const read = await db.messageRead.findOne({ topicId: topic._id, userId }).lean();
    const query = { topicId: topic._id, authorId: { $ne: userId }, status: { $nin: ['Deleted', 'Retracted'] } };
    if (read?.readAt) query.$or = [{ createdAt: { $gt: read.readAt } }, { createdAt: read.readAt, _id: { $gt: read.messageId } }];
    safe.unreadCount = await db.message.countDocuments(query);
    return safe;
};
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
module.exports = { projectTopic, deliverTopicChange, deliverMessageChange };
