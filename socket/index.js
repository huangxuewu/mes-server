const event = require("./event");

module.exports = (socket, io) => {
    console.log("Socket connected: " + socket.id);
    require('../utils/memoryDiagnostics').registerSocket(socket, () => event(socket, io));
};

