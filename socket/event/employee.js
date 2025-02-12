const db = require("../../models");

module.exports = (socket, io) => {

    //
    socket.on('employee:get', (data) => {
        console.log(data);
    });

    socket.on('employee:create', (data) => {
        console.log(data);
    });

    socket.on('employee:update', (data) => {
        console.log(data);
    });

    socket.on('employee:delete', (data) => {
        console.log(data);
    });

    // Timecard
    socket.on('timecard:clockIn', async ({ _id, image }, callback) => {
        try {
            const employee = await db.employee.findById(_id);

            if (!employee) return callback({ status: "error", message: "Employee not found" });

            const timecard = await db.timecard.create({
                employee: _id,
                date: new Date(),
                timeIn: new Date(),
                // image: image.path,
            });

            const profile = await employee.clockIn(timecard._id);

            callback({ status: "success", message: "Timecard created successfully", payload: profile });

        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on('timecard:clockOut', (data) => {
        console.log(data);
    });

    socket.on('timecard:breakStart', (data) => {
        console.log(data);
    });

    socket.on('timecard:breakEnd', (data) => {
        console.log(data);
    });

    socket.on('timecard:get', (data) => {
        console.log(data);
    });

    socket.on('timecard:update', (data) => {
        console.log(data);
    });

    socket.on('timecard:delete', (data) => {
        console.log(data);
    });

    socket.on('timecard:approve', (data) => {
        console.log(data);
    });

    socket.on('timecard:reject', (data) => {
        console.log(data);
    });

    socket.on('timecard:review', (data) => {
        console.log(data);
    });
};