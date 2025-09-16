const { Server } = require("socket.io");
const express = require("express");
const http = require("http");

const TEN_MB = 1e7;

const app = express();
const server = http.createServer(app);
const io = new Server(server, { path: '/socket', cors: { origin: '*' }, maxHttpBufferSize: TEN_MB });

module.exports = { io, app, server };


