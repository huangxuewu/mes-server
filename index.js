const database = require("./config/database");
const { Server } = require("socket.io");
const express = require("express");
const http = require("http");

const app = express();
const server = http.createServer(app);
//add cors
const io = new Server(server, { path: '/socket', cors: { origin: '*' } });
const socketHandler = require("./socket/index");

io.on("connection", (socket) => socketHandler(socket, io));

app.get("/", (req, res) => {
    res.send("Hello World");
});

server.listen(3000, "0.0.0.0", () => {
    console.log("Server is running on port 3000");
});
