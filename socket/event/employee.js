const db = require("../../models");

module.exports = (socket, io) => {

    // get single employee data
    socket.on('employee:get', async (data, callback) => {
        try {
            const employee = await db.employee.findOne(data);
            callback({ status: "success", message: "Employee fetched successfully", payload: employee });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    // get all employees data
    socket.on('employees:get', async (query, callback) => {
        try {
            const employees = await db.employee.find(query);
            callback({ status: "success", message: "Employees fetched successfully", payload: employees });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    // create new employee
    socket.on('employee:create', async (data, callback) => {
        try {
            const employee = await db.employee.create(data);
            callback({ status: "success", message: "Employee created successfully", payload: employee });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on('employee:update', async ({ _id, ...data }, callback) => {
        try {
            const employee = await db.employee.findByIdAndUpdate({ _id }, { $set: data }, { new: true });
            callback({ status: "success", message: "Employee updated successfully", payload: employee });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on('employee:delete', async (_id, callback) => {
        try {
            const employee = await db.employee.deleteOne({ _id });
            callback({ status: "success", message: "Employee deleted successfully", payload: employee });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
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

            // update employee timecard status
            await db.employee.updateOne({ _id }, {
                $set: {
                    timecard: {
                        _id: timecard._id,
                        date: timecard.date,
                        status: "Clocked In",
                    }
                }
            });

            callback({ status: "success", message: "Timecard created successfully", payload: timecard });

        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on('timecard:clockOut', async ({ _id, image }, callback) => {
        try {
            const timecard = await db.timecard.findById(_id);

            if (!timecard) return callback({ status: "error", message: "Timecard not found" });

            const updatedTimecard = await timecard.clockOut(image);

            callback({ status: "success", message: "Timecard updated successfully", payload: updatedTimecard });

        } catch (error) {
            callback({ status: "error", message: error.message });
        }
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

    socket.on('timecard:breakEnd', async ({ _id, image }, callback) => {
        try {
            const timecard = await db.timecard.findById(_id);

            if (!timecard) return callback({ status: "error", message: "Timecard not found" });

            const updatedTimecard = await timecard.breakEnd(image);

            callback({ status: "success", message: "Timecard updated successfully", payload: updatedTimecard });

        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on('timecard:get', async (query, callback) => {
        try {
            const timecard = await db.timecard.findOne(query).populate("employee");
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

    socket.on('timecards:get', async (query, callback) => {
        try {
            const timecards = await db.timecard.find(query).populate("employee");
            callback({ status: "success", message: "Timecards fetched successfully", payload: timecards });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on('enrollment:get', async (query, callback) => {
        try {
            const enrollment = await db.enrollment.findOne(query);
            callback({ status: "success", message: "Enrollment fetched successfully", payload: enrollment });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on('enrollments:get', async (query, callback) => {
        try {
            const enrollments = await db.enrollment.find(query);
            callback({ status: "success", message: "Enrollments fetched successfully", payload: enrollments });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on('enrollment:create', (data) => {
        console.log(data);
    });

    socket.on('enrollment:update', (data) => {
        console.log(data);
    });

};