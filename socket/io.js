const { Server } = require("socket.io");
const express = require("express");
const http = require("http");

const TEN_MB = 1e7;

const app = express();
const server = http.createServer(app);
const io = new Server(server, { path: '/socket', cors: { origin: '*' }, maxHttpBufferSize: TEN_MB });

const SOCKET_APP_TOKEN = process.env.SOCKET_APP_TOKEN || 'MASTERWU';

io.use((socket, next) => {
    if (socket.handshake.auth?.appToken === SOCKET_APP_TOKEN) return next();
    next(new Error('Unauthorized'));
});

module.exports = { io, app, server };


