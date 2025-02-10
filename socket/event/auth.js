const db = require("../../models")
const jwt = require('jsonwebtoken');

module.exports = (socket, io) => {
    // events
    socket.on('auth:login', AuthLogin);              // login page auth
    socket.on('auth:timecard', AuthTimecard);        // timecard page auth

    // function
    async function AuthLogin(payload, callback) {
        try {
            const { username, password } = payload;
            const user = await db.user.findOne({ username, password })

            if (!user) return callback({ status: "error", message: "User not found" });

            const token = jwt.sign({ id: user._id }, "EMS", { expiresIn: '10h' });

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