const mongoose = require("mongoose");
const db = require("../../models");

const PERMS = {
    eventPublicView: "office.calendar.event.public.view",
    eventPublicCreate: "office.calendar.event.public.create",
    eventPublicUpdate: "office.calendar.event.public.update",
    eventPublicDelete: "office.calendar.event.public.delete",
    taskCollaborateCreate: "office.calendar.task.collaborate.create",
    taskCollaborateUpdate: "office.calendar.task.collaborate.update",
    taskCollaborateDelete: "office.calendar.task.collaborate.delete",
};

const toId = (id) => {
    if (!id) return null;
    return mongoose.Types.ObjectId.isValid(id) ? new mongoose.Types.ObjectId(id) : null;
};

const sameId = (a, b) => String(a) === String(b);

const hasPermission = (user, action, resource) => {
    if (!user) return false;
    if (user.role === "System") return true;
    const perms = user.permission?.[action];
    return Array.isArray(perms) && perms.includes(resource);
};

const loadUser = async (userId) => {
    const oid = toId(userId);
    if (!oid) return null;
    return db.user.findById(oid).lean();
};

const eventVisibilityFilter = (userId, user) => {
    const oid = toId(userId);
    const notOptedOut = { optOutIds: { $nin: [oid] } };
    const clauses = [
        { visibility: "private", ownerId: oid },
        { visibility: "public", ownerId: oid },
        { visibility: "public", participantIds: oid },
    ];
    if (hasPermission(user, "view", PERMS.eventPublicView))
        clauses.push({ visibility: "public", ...notOptedOut });
    return { $or: clauses };
};

const isEventParticipant = (event, userId) =>
    (event.participantIds ?? []).some(id => sameId(id, userId));

const isTaskParticipant = (task, userId) =>
    (task.participantIds ?? []).some(id => sameId(id, userId));

const hasOptedOut = (event, userId) =>
    (event.optOutIds ?? []).some(id => sameId(id, userId));

const hasTaskOptedOut = (task, userId) =>
    (task.optOutIds ?? []).some(id => sameId(id, userId));

const isOptOutOnlyUpdate = (fields, event, userId) => {
    const keys = Object.keys(fields).filter(k => !["_id", "userId"].includes(k));
    if (keys.length !== 1 || keys[0] !== "optOutIds") return false;
    if (!isEventParticipant(event, userId)) return false;
    const prev = new Set((event.optOutIds ?? []).map(String));
    const next = (fields.optOutIds ?? []).map(String);
    if (next.length !== prev.size + 1) return false;
    return next.every(id => prev.has(id) || sameId(id, userId));
};

const buildEventRangeFilter = (rangeStart, rangeEnd) => {
    const start = new Date(rangeStart);
    const end = new Date(rangeEnd);
    return {
        $or: [
            {
                repeat: { $ne: true },
                start: { $lte: end },
                end: { $gte: start },
            },
            {
                repeat: true,
                start: { $lte: end },
                $or: [
                    { "repeatRule.until": { $in: [null, ""] } },
                    { "repeatRule.until": { $gte: rangeStart.slice(0, 10) } },
                ],
            },
        ],
    };
};

const assertEventRead = (event, userId, user) => {
    if (sameId(event.ownerId, userId)) return null;
    if (event.visibility === "private")
        return "You do not have access to this event";
    if (isEventParticipant(event, userId)) return null;
    if (hasOptedOut(event, userId))
        return "You do not have access to this event";
    if (!hasPermission(user, "view", PERMS.eventPublicView))
        return "You do not have permission to view public events";
    return null;
};

const assertEventWrite = (event, userId, user, action, fields = {}) => {
    if (event && sameId(event.ownerId, userId)) return null;

    if (action === "update" && event && isOptOutOnlyUpdate(fields, event, userId))
        return null;

    if (!event) {
        if (action === "create" && hasPermission(user, "create", PERMS.eventPublicCreate)) return null;
        if (action === "create") return "You do not have permission to create public events";
        return "Event not found";
    }

    return "Only the event owner can modify this event";
};

const isTaskOptOutOnlyUpdate = (fields, task, userId) => {
    const keys = Object.keys(fields).filter(k => !["_id", "userId"].includes(k));
    if (keys.length !== 1 || keys[0] !== "optOutIds") return false;
    if (!isTaskParticipant(task, userId)) return false;
    const prev = new Set((task.optOutIds ?? []).map(String));
    const next = (fields.optOutIds ?? []).map(String);
    if (next.length !== prev.size + 1) return false;
    return next.every(id => prev.has(id) || sameId(id, userId));
};

const assertTaskWrite = (task, userId, user, action, fields = {}) => {
    if (action === "create") {
        if (task?.taskMode === "collaborate" && !hasPermission(user, "create", PERMS.taskCollaborateCreate))
            return "You do not have permission to create collaborate tasks";
        return null;
    }

    if (!task) return "Task not found";

    if (sameId(task.ownerId, userId)) return null;

    if (action === "update" && isTaskOptOutOnlyUpdate(fields, task, userId))
        return null;

    if (task.taskMode === "self")
        return "You do not have access to this task";

    return "Only the task owner can modify this task";
};

const sanitizeTaskPayload = (data, { participantIds } = {}) => {
    const payload = stripTaskPayload(data);
    const ids = participantIds ?? payload.participantIds ?? [];
    payload.optOutIds = normalizeOptOutIds(ids, payload.optOutIds);
    return payload;
};

const normalizeOptOutIds = (participantIds, optOutIds) => {
    const participants = new Set((participantIds ?? []).map(String));
    return (optOutIds ?? [])
        .map(id => toId(id))
        .filter(id => id && participants.has(String(id)));
};

const sanitizeEventPayload = (data, { isOwner = false, participantIds } = {}) => {
    const payload = stripEventPayload(data);
    if (!isOwner) return payload;

    const ids = participantIds ?? payload.participantIds ?? [];
    payload.optOutIds = normalizeOptOutIds(ids, payload.optOutIds);
    return payload;
};

const stripEventPayload = (data) => {
    const {
        _id, id, userId, participants, participantCount, seriesId,
        createdAt, updatedAt, __v,
        ...rest
    } = data;
    return rest;
};

const stripTaskPayload = (data) => {
    const {
        _id, id, userId,
        createdAt, updatedAt, __v,
        ...rest
    } = data;
    return rest;
};

module.exports = (socket, io) => {
    socket.on("calendarEvents:fetch", async ({ rangeStart, rangeEnd, userId }, callback) => {
        try {
            if (!rangeStart || !rangeEnd || !userId)
                return callback({ status: "error", message: "rangeStart, rangeEnd, and userId are required" });

            const user = await loadUser(userId);
            if (!user) return callback({ status: "error", message: "User not found" });

            const events = await db.calendarEvent.find({
                $and: [
                    eventVisibilityFilter(userId, user),
                    buildEventRangeFilter(rangeStart, rangeEnd),
                ],
            }).sort({ start: 1 });

            callback({ status: "success", message: "Calendar events fetched", payload: events });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on("calendarEvent:get", async ({ _id, userId }, callback) => {
        try {
            const user = await loadUser(userId);
            if (!user) return callback({ status: "error", message: "User not found" });

            const event = await db.calendarEvent.findById(_id);
            if (!event) return callback({ status: "error", message: "Event not found" });

            const err = assertEventRead(event, userId, user);
            if (err) return callback({ status: "error", message: err });

            callback({ status: "success", message: "Event fetched", payload: event });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on("calendarEvent:create", async (data, callback) => {
        try {
            const { userId, visibility, ...rest } = data;
            const user = await loadUser(userId);
            if (!user) return callback({ status: "error", message: "User not found" });

            if (visibility === "public") {
                const err = assertEventWrite(null, userId, user, "create");
                if (err) return callback({ status: "error", message: err });
            }

            const oid = toId(userId);
            const payload = stripEventPayload({ ...rest, visibility: visibility ?? "private" });
            const event = await db.calendarEvent.create({
                ...payload,
                optOutIds: [],
                ownerId: oid,
                createdBy: oid,
            });

            callback({ status: "success", message: "Event created", payload: event });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on("calendarEvent:update", async ({ _id, userId, ...data }, callback) => {
        try {
            const user = await loadUser(userId);
            if (!user) return callback({ status: "error", message: "User not found" });

            const event = await db.calendarEvent.findById(_id);
            if (!event) return callback({ status: "error", message: "Event not found" });

            const err = assertEventWrite(event, userId, user, "update", data);
            if (err) return callback({ status: "error", message: err });

            if (data.visibility === "public" && event.visibility !== "public") {
                const createErr = assertEventWrite(null, userId, user, "create");
                if (createErr) return callback({ status: "error", message: createErr });
            }

            const isOwner = sameId(event.ownerId, userId);
            const payload = isOwner
                ? sanitizeEventPayload(data, {
                    isOwner: true,
                    participantIds: data.participantIds ?? event.participantIds,
                })
                : stripEventPayload(data);

            const updated = await db.calendarEvent.findByIdAndUpdate(
                _id,
                { $set: payload },
                { new: true, runValidators: true },
            );

            callback({ status: "success", message: "Event updated", payload: updated });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on("calendarEvent:optOut", async ({ _id, userId }, callback) => {
        try {
            const user = await loadUser(userId);
            if (!user) return callback({ status: "error", message: "User not found" });

            const event = await db.calendarEvent.findById(_id);
            if (!event) return callback({ status: "error", message: "Event not found" });

            const readErr = assertEventRead(event, userId, user);
            if (readErr) return callback({ status: "error", message: readErr });

            if (sameId(event.ownerId, userId))
                return callback({ status: "error", message: "Event owners cannot opt out" });

            if (!isEventParticipant(event, userId))
                return callback({ status: "error", message: "Only participants can opt out of this event" });

            if (hasOptedOut(event, userId))
                return callback({ status: "success", message: "Already opted out", payload: event });

            const updated = await db.calendarEvent.findByIdAndUpdate(
                _id,
                { $addToSet: { optOutIds: toId(userId) } },
                { new: true, runValidators: true },
            );

            callback({ status: "success", message: "Opted out of event", payload: updated });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on("calendarEvent:delete", async ({ _id, userId }, callback) => {
        try {
            const user = await loadUser(userId);
            if (!user) return callback({ status: "error", message: "User not found" });

            const event = await db.calendarEvent.findById(_id);
            if (!event) return callback({ status: "error", message: "Event not found" });

            const err = assertEventWrite(event, userId, user, "delete");
            if (err) return callback({ status: "error", message: err });

            await db.calendarEvent.deleteOne({ _id });
            callback({ status: "success", message: "Event deleted" });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on("calendarTasks:fetch", async ({ userId }, callback) => {
        try {
            if (!userId) return callback({ status: "error", message: "userId is required" });

            const oid = toId(userId);
            const tasks = await db.calendarTask.find({
                $or: [
                    { ownerId: oid },
                    { taskMode: "collaborate", participantIds: oid },
                ],
            }).sort({ dueDate: 1, createdAt: -1 });

            callback({ status: "success", message: "Calendar tasks fetched", payload: tasks });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on("calendarTask:get", async ({ _id, userId }, callback) => {
        try {
            const task = await db.calendarTask.findById(_id);
            if (!task) return callback({ status: "error", message: "Task not found" });

            const isOwner = sameId(task.ownerId, userId);
            const isParticipant = (task.participantIds ?? []).some(id => sameId(id, userId));
            if (!isOwner && !(task.taskMode === "collaborate" && isParticipant))
                return callback({ status: "error", message: "You do not have access to this task" });

            callback({ status: "success", message: "Task fetched", payload: task });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on("calendarTask:create", async (data, callback) => {
        try {
            const { userId, taskMode, ...rest } = data;
            const user = await loadUser(userId);
            if (!user) return callback({ status: "error", message: "User not found" });

            const err = assertTaskWrite(
                { taskMode: taskMode ?? "self" },
                userId,
                user,
                "create",
            );
            if (err) return callback({ status: "error", message: err });

            const oid = toId(userId);
            const task = await db.calendarTask.create({
                ...stripTaskPayload(rest),
                taskMode: taskMode ?? "self",
                optOutIds: [],
                ownerId: oid,
                createdBy: oid,
            });

            callback({ status: "success", message: "Task created", payload: task });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on("calendarTask:update", async ({ _id, userId, ...data }, callback) => {
        try {
            const user = await loadUser(userId);
            if (!user) return callback({ status: "error", message: "User not found" });

            const task = await db.calendarTask.findById(_id);
            if (!task) return callback({ status: "error", message: "Task not found" });

            const err = assertTaskWrite(task, userId, user, "update", data);
            if (err) return callback({ status: "error", message: err });

            if (data.taskMode === "collaborate" && task.taskMode !== "collaborate") {
                if (!hasPermission(user, "create", PERMS.taskCollaborateCreate))
                    return callback({ status: "error", message: "You do not have permission to create collaborate tasks" });
            }

            const isOwner = sameId(task.ownerId, userId);
            const payload = isOwner
                ? sanitizeTaskPayload(data, { participantIds: data.participantIds ?? task.participantIds })
                : stripTaskPayload(data);

            const updated = await db.calendarTask.findByIdAndUpdate(
                _id,
                { $set: payload },
                { new: true, runValidators: true },
            );

            callback({ status: "success", message: "Task updated", payload: updated });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on("calendarTask:optOut", async ({ _id, userId }, callback) => {
        try {
            const user = await loadUser(userId);
            if (!user) return callback({ status: "error", message: "User not found" });

            const task = await db.calendarTask.findById(_id);
            if (!task) return callback({ status: "error", message: "Task not found" });

            if (task.taskMode !== "collaborate")
                return callback({ status: "error", message: "Only collaborate tasks can be opted out" });

            if (sameId(task.ownerId, userId))
                return callback({ status: "error", message: "Task owners cannot opt out" });

            if (!isTaskParticipant(task, userId))
                return callback({ status: "error", message: "Only participants can opt out of this task" });

            if (hasTaskOptedOut(task, userId))
                return callback({ status: "success", message: "Already opted out", payload: task });

            const updated = await db.calendarTask.findByIdAndUpdate(
                _id,
                { $addToSet: { optOutIds: toId(userId) } },
                { new: true, runValidators: true },
            );

            callback({ status: "success", message: "Opted out of task", payload: updated });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on("calendarTask:delete", async ({ _id, userId }, callback) => {
        try {
            const user = await loadUser(userId);
            if (!user) return callback({ status: "error", message: "User not found" });

            const task = await db.calendarTask.findById(_id);
            if (!task) return callback({ status: "error", message: "Task not found" });

            const err = assertTaskWrite(task, userId, user, "delete");
            if (err) return callback({ status: "error", message: err });

            await db.calendarTask.deleteOne({ _id });
            callback({ status: "success", message: "Task deleted" });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });
};
