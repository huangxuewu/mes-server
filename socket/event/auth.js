const db = require("../../models")
const jwt = require('jsonwebtoken');
const { JWT_SECRET, bindSocketSession, unbindSocketSession } = require("../session");

module.exports = (socket, io) => {
    // events
    socket.on('auth:login', AuthLogin);              // login page auth
    socket.on('auth:timecard', AuthTimecard);        // timecard page auth
    socket.on('auth:bind', AuthBind);                // bind an existing token to this socket (reconnect)
    socket.on('auth:unbind', AuthUnbind);            // clear the socket session (logout)

    // function
    async function AuthLogin(payload, callback) {
        try {
            const { username, password } = payload;
            const user = await db.user.findOne({ username, password })

            if (!user) return callback({ status: "error", message: "User not found" });

            const token = jwt.sign({ id: user._id }, JWT_SECRET, { expiresIn: '10h' });
            bindSocketSession(socket, user);

            callback({
                status: "success",
                message: "Login successful",
                payload: { token, user }
            });

        } catch (err) {
            callback({
                status: "error",
                message: err.message
            });
        }
    }

    async function AuthBind(payload, callback) {
        try {
            const decoded = jwt.verify(payload?.token, JWT_SECRET);
            const user = await db.user.findById(decoded.id).lean();

            if (!user) return callback?.({ status: "error", message: "User not found" });

            bindSocketSession(socket, user);
            callback?.({ status: "success", message: "Session bound", payload: { userId: String(user._id) } });

        } catch (err) {
            callback?.({ status: "error", message: "Invalid session token" });
        }
    }

    function AuthUnbind(payload, callback) {
        unbindSocketSession(socket);
        callback?.({ status: "success", message: "Session unbound" });
    }

    async function AuthTimecard(pin, callback) {
        try {
            const isDeleted = false;
            const employee = await db.employee.findOne({ pin, isDeleted }).lean();

            return employee
                ? callback({ status: "success", message: "Access Pin Verified", payload: { employee } })
                : callback({ status: "error", message: "Employee not found" });

        } catch (err) {
            callback({ status: "error", message: err.message });
        }
    }

}
