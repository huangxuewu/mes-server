const db = require("../../models")
const jwt = require('jsonwebtoken');
const { verifyLoginPassword } = require('../../utils/userAccount');
const { JWT_SECRET, bindSocketSession, unbindSocketSession, privateUser, resolveUserPermissions } = require("../session");

module.exports = (socket, io) => {
    // events
    socket.on('auth:login', AuthLogin);              // login page auth
    socket.on('auth:timecard', AuthTimecard);        // timecard page auth
    socket.on('auth:bind', AuthBind);                // bind an existing token to this socket (reconnect)
    socket.on('auth:unbind', AuthUnbind);            // clear the socket session (logout)
    socket.on('disconnect', () => unbindSocketSession(socket));

    // function
    async function AuthLogin(payload, callback) {
        try {
            unbindSocketSession(socket);
            const attempt = socket.data.sessionGeneration;
            if (!JWT_SECRET) throw new Error('Authentication secret is not configured');
            if (typeof payload?.username !== 'string' || typeof payload?.password !== 'string') throw new Error('Invalid credentials');
            const { username, password } = payload;
            const user = await resolveUserPermissions(await db.user.findOne({ username }).lean());
            const passwordValid = user && await verifyLoginPassword(user.password, password);
            if (attempt !== socket.data.sessionGeneration) throw new Error('Sign-in superseded');

            if (!user || !passwordValid || user.status !== 'Active') return callback({ status: "error", message: "Invalid credentials" });

            const token = jwt.sign({ id: user._id }, JWT_SECRET, { expiresIn: '10h' });
            bindSocketSession(socket, user, jwt.decode(token).exp * 1000);

            callback({
                status: "success",
                message: "Login successful",
                payload: { token, user: privateUser(user) }
            });

        } catch (err) {
            callback({
                status: "error",
                message: err.message
            });
        }
    }

    async function AuthBind(payload, callback) {
        unbindSocketSession(socket);
        const attempt = socket.data.sessionGeneration;
        try {
            if (!JWT_SECRET) throw new Error('Authentication secret is not configured');
            const decoded = jwt.verify(payload?.token, JWT_SECRET);
            if (!Number.isFinite(decoded.exp) || decoded.exp * 1000 <= Date.now()) throw new Error('Expired session token');
            const user = await resolveUserPermissions(await db.user.findById(decoded.id).lean());
            if (attempt !== socket.data.sessionGeneration) throw new Error('Sign-in superseded');

            if (!user || user.status !== 'Active') return callback?.({ status: "error", message: "Account unavailable" });

            bindSocketSession(socket, user, decoded.exp * 1000);
            callback?.({ status: "success", message: "Session bound", payload: { userId: String(user._id), user: privateUser(user) } });

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
            if (typeof pin !== 'string' && typeof pin !== 'number') throw new Error('Invalid PIN');
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
