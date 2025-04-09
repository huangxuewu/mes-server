const { io, app, server } = require("./socket/io");
const socketHandler = require("./socket/index");

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "0.0.0.0";

io.on("connection", (socket) => socketHandler(socket, io));

app.get("/", (req, res) => {
    res.send("Hello World");
});

server.listen(PORT, HOST, () => {
    //print the local ip address
    const os = require("os");
    const interfaces = os.networkInterfaces();
    let ipAddress = "localhost";

    for (const interface of Object.values(interfaces)) {
        for (const address of interface) {
            if (address.family === "IPv4" && !address.internal) {
                ipAddress = address.address;
            }
        }
    }

    console.log("Server is running on ", "http://" + ipAddress + ":" + PORT);
});
