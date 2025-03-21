const { io, app, server } = require("./socket/io");
const socketHandler = require("./socket/index");

io.on("connection", (socket) => socketHandler(socket, io));

app.get("/", (req, res) => {
    res.send("Hello World");
});

server.listen(3000, "0.0.0.0", () => {
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

    console.log("Server is running on ", "http://" + ipAddress + ":3000");
});
