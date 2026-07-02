const JWT_SECRET = process.env.JWT_SECRET || "EMS";

// Room joined by sockets whose user holds office.calendar.event.public.view,
// so public calendar events can be broadcast without enumerating users.
const PUBLIC_EVENT_ROOM = "calendar:publicEvent";

const PUBLIC_EVENT_VIEW_PERM = "office.calendar.event.public.view";

const userRoom = (userId) => `user:${String(userId)}`;

const getSessionUserId = (socket) => socket.data?.userId ?? null;

const hasPermission = (user, action, resource) => {
    if (!user) return false;
    if (user.role === "System") return true;
    const perms = user.permission?.[action];
    return Array.isArray(perms) && perms.includes(resource);
};

const bindSocketSession = (socket, user) => {
    unbindSocketSession(socket);
    socket.data.userId = String(user._id);
    socket.join(userRoom(user._id));
    if (hasPermission(user, "view", PUBLIC_EVENT_VIEW_PERM))
        socket.join(PUBLIC_EVENT_ROOM);
};

const unbindSocketSession = (socket) => {
    if (socket.data.userId) socket.leave(userRoom(socket.data.userId));
    socket.leave(PUBLIC_EVENT_ROOM);
    socket.data.userId = null;
};

module.exports = {
    JWT_SECRET,
    PUBLIC_EVENT_ROOM,
    userRoom,
    getSessionUserId,
    hasPermission,
    bindSocketSession,
    unbindSocketSession,
};
