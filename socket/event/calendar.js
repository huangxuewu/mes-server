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
    const clauses = [
        { visibility: "private", ownerId: oid },
        { visibility: "public", ownerId: oid },
    ];
    if (hasPermission(user, "view", PERMS.eventPublicView))
        clauses.push({ visibility: "public" });
    return { $or: clauses };
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
    if (!hasPermission(user, "view", PERMS.eventPublicView))
        return "You do not have permission to view public events";
    return null;
};

const assertEventWrite = (event, userId, user, action) => {
    if (event && sameId(event.ownerId, userId)) return null;

    const permMap = {
        create: PERMS.eventPublicCreate,
        update: PERMS.eventPublicUpdate,
        delete: PERMS.eventPublicDelete,
    };
    const resource = permMap[action];

    if (!event) {
        if (action === "create" && hasPermission(user, "create", resource)) return null;
        if (action === "create") return "You do not have permission to create public events";
        return "Event not found";
    }

    if (event.visibility === "private")
        return "You do not have access to this event";

    if (!hasPermission(user, action, resource))
        return `You do not have permission to ${action} public events`;

    return null;
};

const isCompletionOnlyUpdate = (fields) => {
    const keys = Object.keys(fields).filter(k => !["_id", "userId"].includes(k));
    if (!keys.length) return false;
    return keys.every(k => ["completions", "completed"].includes(k));
};

const assertTaskWrite = (task, userId, user, action, fields = {}) => {
    if (!task) return action === "create" ? null : "Task not found";

    const isOwner = sameId(task.ownerId, userId);
    const isCollaborate = task.taskMode === "collaborate";
    const participantIds = (task.participantIds ?? []).map(String);
    const isParticipant = participantIds.includes(String(userId));

    if (task.taskMode === "self") {
        if (action === "create") return null;
        return isOwner ? null : "You do not have access to this task";
    }

    if (action === "create") {
        return hasPermission(user, "create", PERMS.taskCollaborateCreate)
            ? null
            : "You do not have permission to create collaborate tasks";
    }

    if (isOwner) return null;

    if (action === "update" && isParticipant && isCompletionOnlyUpdate(fields))
        return null;

    const permMap = {
        update: PERMS.taskCollaborateUpdate,
        delete: PERMS.taskCollaborateDelete,
    };
    const resource = permMap[action];

    if (!isCollaborate) return "You do not have access to this task";

    if (!hasPermission(user, action, resource))
        return `You do not have permission to ${action} collaborate tasks`;

    return null;
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

            const err = assertEventWrite(event, userId, user, "update");
            if (err) return callback({ status: "error", message: err });

            if (data.visibility === "public" && event.visibility !== "public") {
                const createErr = assertEventWrite(null, userId, user, "create");
                if (createErr) return callback({ status: "error", message: createErr });
            }

            const updated = await db.calendarEvent.findByIdAndUpdate(
                _id,
                { $set: stripEventPayload(data) },
                { new: true, runValidators: true },
            );

            callback({ status: "success", message: "Event updated", payload: updated });
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
                const createErr = assertTaskWrite({ taskMode: "collaborate" }, userId, user, "create");
                if (createErr) return callback({ status: "error", message: createErr });
            }

            const updated = await db.calendarTask.findByIdAndUpdate(
                _id,
                { $set: stripTaskPayload(data) },
                { new: true, runValidators: true },
            );

            callback({ status: "success", message: "Task updated", payload: updated });
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
