const path = require('path');
const express = require('express');
const { io, app, server } = require("./socket/io");
const socketHandler = require("./socket/index");

// Import API routes
const apiRoutes = require('./api');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "0.0.0.0";

// View engine setup (same as app.js)
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'jade');

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Mount API routes
app.use('/api', apiRoutes);

// Socket.IO connection
io.on("connection", (socket) => socketHandler(socket, io));

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Render views
app.get("/", (req, res) => {
    res.render('index', { title: 'MES System' });
});

// API health check
app.get("/health", (req, res) => {
    res.json({ status: 'OK', message: 'Server is running' });
});

server.listen(PORT, HOST, () => {
    console.log("Server is running on ", "http://" + HOST + ":" + PORT);
});
