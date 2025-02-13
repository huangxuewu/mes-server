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
                date: new Date().toISOString().split('T')[0],
                timeIn: new Date(),
                timeInImage: image,
            });

            const profile = await employee.clockIn(timecard._id);

            callback({ status: "success", message: "Timecard created successfully", payload: timecard });

        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on('timecard:clockOut', (data) => {

        console.log(data);
    });

    socket.on('timecard:breakStart', async ({ _id, image }, callback) => {
        try {
            const timecard = await db.timecard.findById(_id);

            if (!timecard) return callback({ status: "error", message: "Timecard not found" });

            const updatedTimecard = await timecard.breakStart(image);

            callback({ status: "success", message: "Timecard updated successfully", payload: updatedTimecard });

        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on('timecard:breakEnd', (data) => {
        console.log(data);
    });

    socket.on('timecard:get', async ({ _id }, callback) => {
        try {
            const timecard = await db.timecard.findById(_id).populate("employee");
            callback({ status: "success", message: "Timecard fetched successfully", payload: timecard });

        } catch (error) {
            callback({ status: "error", message: error.message });
        }
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