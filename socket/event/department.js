const db = require("../../models");

module.exports = (socket, io) => {
    // Create new department
    socket.on("department:create", async (data, callback) => {
        try {
            const department = await db.department.create(data);
            callback({ status: "success", message: "Department created successfully", payload: department });
            
            // Broadcast to all connected clients
            io.emit("department:created", department);
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    // Update department
    socket.on("department:update", async ({ _id, ...data }, callback) => {
        try {
            const department = await db.department.findByIdAndUpdate(_id, { $set: data }, { new: true });
            if (!department) {
                return callback({ status: "error", message: "Department not found" });
            }
            callback({ status: "success", message: "Department updated successfully", payload: department });
            
            // Broadcast to all connected clients
            io.emit("department:updated", department);
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    // Delete department
    socket.on("department:delete", async (_id, callback) => {
        try {
            const result = await db.department.deleteOne({ _id });
            if (result.deletedCount === 0) {
                return callback({ status: "error", message: "Department not found" });
            }
            callback({ status: "success", message: "Department deleted successfully" });
            
            // Broadcast to all connected clients
            io.emit("department:deleted", { _id });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    // Get single department
    socket.on("department:get", async (data, callback) => {
        try {
            const department = await db.department.findOne(data);
            callback({ status: "success", message: "Department fetched successfully", payload: department });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    // Get all departments
    socket.on("departments:get", async (query, callback) => {
        try {
            const departments = await db.department.find(query);
            callback({ status: "success", message: "Departments fetched successfully", payload: departments });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });
};
