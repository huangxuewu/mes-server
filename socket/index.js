const event = require("./event");

module.exports = (socket, io) => {
    console.log("Socket connected: " + socket.id);
    event(socket, io);
};

