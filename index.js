const memory = require('./utils/memoryDiagnostics');
memory.start();
const dns = require("node:dns");
dns.setDefaultResultOrder("ipv4first");
dns.setServers(["8.8.8.8", "8.8.4.4"]);

const path = require('path');
const express = require('express');
const session = require('express-session');
const { io, app, server } = require("./socket/io");
server.on('close', memory.stop);
const socketHandler = require("./socket/index");
const { attachCollaboration } = require("./socket/collaboration");
const { startDocumentLifecycle } = require("./utils/documentLifecycle");
const { startMessageAttachmentCleanup } = require('./utils/messageAttachmentCleanup');
const dataSync = require('./socket/dataSync');

// Import API routes
const apiRoutes = require('./api');
const oauthRouter = require('./routes/oauth');
const finishProductLabelRouter = require('./routes/finishProductLabel');
memory.sample('startup:modules-loaded');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "0.0.0.0";

// View engine setup (same as app.js)
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'pug');

// Middleware
app.use((req, res, next) => {
    const label = req.path.startsWith('/signature-pad') ? 'http:signature-pad'
        : req.path.startsWith('/api') ? 'http:api' : 'http:other';
    const finish = memory.begin(label);
    res.once('finish', () => finish(res.statusCode >= 500));
    res.once('close', () => finish(!res.writableFinished));
    next();
});
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET,PUT,POST,DELETE,OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Content-Length, X-Requested-With');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});
app.use('/register', require('./routes/userRegistration'));
app.use('/signature-pad', require('./routes/signaturePad')());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
    secret: process.env.SESSION_SECRET || 'your-session-secret',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false }
}));

// Mount API routes
app.use('/api', apiRoutes);
app.use('/station-updates', require('./routes/stationUpdates'));
app.use(oauthRouter);
app.use('/addon/labelMaker/finishProduct', finishProductLabelRouter);
app.use('/sharing', require('./routes/sharing')(require('./socket/sharing').getSharing(io).phone));

// Socket.IO connection
io.on("connection", (socket) => socketHandler(socket, io));
attachCollaboration(server);
startDocumentLifecycle(io);
startMessageAttachmentCleanup();
require('./utils/stationScreenshots').getStationScreenshots(io).start();
dataSync.start();
const stopLoadNotifications = require('./utils/outboundWorkflowState').createOutboundWorkflowState(require('./models')).start();
server.on('close', stopLoadNotifications);
const asnMonitor = require('./utils/edi/asnMonitor').createAsnMonitor({
    db: require('./models'), getClient: require('./utils/edi/client').getClient,
});
asnMonitor.start();
server.on('close', () => { void asnMonitor.stop(); });
const invoiceMonitor = require('./utils/edi/invoiceMonitor').createInvoiceMonitor({
    db: require('./models'), getClient: require('./utils/edi/client').getClient, flow: require('./utils/edi/salesInvoices'),
});
invoiceMonitor.start();
server.on('close', () => { void invoiceMonitor.stop(); });

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
    memory.sample('startup:listening');
    console.log("Server is running on ", "http://" + HOST + ":" + PORT);
    require('./utils/stationRelease').startReleaseChecks();
});
