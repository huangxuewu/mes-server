const dayjs = require("dayjs");
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
    socket.on('timecard:clockIn', async (payload, callback) => {
        try {
            const timecard = await db.timecard.clockIn(payload);
            callback({ status: "success", message: "Timecard created successfully", payload: timecard });

        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on('timecard:clockOut', async (payload, callback) => {
        try {
            const timecard = await db.timecard.clockOut(payload);
            callback({ status: "success", message: "Timecard clocked out successfully", payload: timecard });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on('timecard:breakStart', async (payload, callback) => {
        try {
            const timecard = await db.timecard.breakStart(payload);
            callback({ status: "success", message: "Timecard break started successfully", payload: timecard });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on('timecard:breakEnd', async (payload, callback) => {
        try {
            const timecard = await db.timecard.breakEnd(payload);
            callback({ status: "success", message: "Timecard break ended successfully", payload: timecard });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on('timecard:fetch', async (query, callback) => {
        try {
            const timecards = await db.timecard.find(query);
            callback({ status: "success", message: "Timecards fetched successfully", payload: timecards });

        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on('timecard:create', async (payload, callback) => {
        try {
            const timecard = await db.timecard.supplement(payload);

            callback({ status: "success", message: "Timecard created successfully", payload: timecard });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on('timecard:update', async (data, callback) => {
        try {
            const { _id, ...rest } = data;
            const timecard = await db.timecard.findByIdAndUpdate({ _id }, { $set: rest }, { new: true });
            callback({ status: "success", message: "Timecard updated successfully", payload: timecard });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
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