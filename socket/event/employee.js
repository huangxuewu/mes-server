const dayjs = require("../../utils/dayjs");
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
            const update = { ...rest };

            if (Object.prototype.hasOwnProperty.call(update, 'punches')) {
                update.punches = db.timecard.sanitizePunches(update.punches, { preserveUndefined: true });
            }

            const timecard = await db.timecard.findByIdAndUpdate(
                { _id },
                { $set: update },
                { new: true, runValidators: true, context: 'query' }
            );
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

    // Overtime schedule
    socket.on('overtime:fetch', async (query, callback) => {
        try {
            const overtimes = await db.overtime.find(query);
            callback({ status: "success", message: "Overtime schedules fetched successfully", payload: overtimes });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on('overtime:upsert', async (payload, callback) => {
        try {
            const { employeeId, date, ...rest } = payload;
            const overtime = await db.overtime.findOneAndUpdate(
                { employeeId, date },
                { $set: { employeeId, date, ...rest } },
                { new: true, upsert: true }
            );
            callback({ status: "success", message: "Overtime schedule saved successfully", payload: overtime });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on('overtime:delete', async ({ _id }, callback) => {
        try {
            await db.overtime.deleteOne({ _id });
            callback({ status: "success", message: "Overtime schedule deleted successfully", payload: { _id } });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    // Work schedule (team-level)
    socket.on('workScheduleTemplate:get', async ({ _id }, callback) => {
        try {
            const template = _id
                ? await db.workScheduleTemplate.findOne({ _id })
                : await db.workScheduleTemplate.findOne({ isDefault: true })
                    || await db.workScheduleTemplate.findOne().sort({ createdAt: 1 });
            callback({ status: "success", message: "Work schedule template fetched successfully", payload: template });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on('workScheduleTemplates:fetch', async (_query, callback) => {
        try {
            const templates = await db.workScheduleTemplate.find({}).sort({ name: 1 });
            callback({ status: "success", message: "Work schedule templates fetched successfully", payload: templates });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on('workScheduleTemplate:upsert', async (payload, callback) => {
        try {
            const { _id, isDefault, name, teamId: _teamId, departmentId: _departmentId, ...rest } = payload;
            if (!name?.trim())
                return callback({ status: "error", message: "Template name is required" });

            const trimmedName = String(name).trim();
            const duplicate = await db.workScheduleTemplate.findOne({
                name: trimmedName,
                ...(_id ? { _id: { $ne: _id } } : {})
            });
            if (duplicate)
                return callback({ status: "error", message: "A template with this name already exists" });

            if (isDefault)
                await db.workScheduleTemplate.updateMany({ ...(_id ? { _id: { $ne: _id } } : {}) }, { $set: { isDefault: false } });

            const existingCount = await db.workScheduleTemplate.countDocuments({ ...(_id ? { _id: { $ne: _id } } : {}) });
            const shouldDefault = !!isDefault || existingCount === 0;

            if (shouldDefault && !isDefault)
                await db.workScheduleTemplate.updateMany({ ...(_id ? { _id: { $ne: _id } } : {}) }, { $set: { isDefault: false } });

            const doc = {
                name: trimmedName,
                isDefault: shouldDefault,
                ...rest
            };

            const template = _id
                ? await db.workScheduleTemplate.findOneAndUpdate({ _id }, { $set: doc }, { new: true })
                : await db.workScheduleTemplate.create(doc);

            callback({ status: "success", message: "Work schedule template saved successfully", payload: template });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on('workScheduleTemplate:delete', async ({ _id }, callback) => {
        try {
            if (!_id) return callback({ status: "error", message: "Template id is required" });

            const removed = await db.workScheduleTemplate.findOneAndDelete({ _id });
            if (!removed) return callback({ status: "error", message: "Template not found" });

            if (removed.isDefault) {
                const next = await db.workScheduleTemplate.findOne().sort({ createdAt: 1 });
                if (next) await db.workScheduleTemplate.updateOne({ _id: next._id }, { $set: { isDefault: true } });
            }

            callback({ status: "success", message: "Work schedule template deleted successfully", payload: { _id } });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on('workSchedules:fetch', async (query, callback) => {
        try {
            const schedules = await db.workSchedule.find(query);
            callback({ status: "success", message: "Work schedules fetched successfully", payload: schedules });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on('workSchedule:upsert', async (payload, callback) => {
        try {
            const { teamId, departmentId, date, ...rest } = payload;
            const schedule = await db.workSchedule.findOneAndUpdate(
                { teamId, date },
                { $set: { teamId, departmentId, date, ...rest } },
                { new: true, upsert: true }
            );
            callback({ status: "success", message: "Work schedule saved successfully", payload: schedule });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on('workSchedule:delete', async ({ teamId, date }, callback) => {
        try {
            await db.workSchedule.deleteOne({ teamId, date });
            callback({ status: "success", message: "Work schedule deleted successfully", payload: { teamId, date } });
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