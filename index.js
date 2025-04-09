const { io, app, server } = require("./socket/io");
const socketHandler = require("./socket/index");

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "0.0.0.0";

io.on("connection", (socket) => socketHandler(socket, io));

app.get("/", (req, res) => {
    res.send("Hello World");
});

server.listen(PORT, HOST, () => {
    console.log("Server is running on ", "http://" + HOST + ":" + PORT);
});
