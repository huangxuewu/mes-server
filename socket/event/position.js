const db = require("../../models");

module.exports = (socket, io) => {
    // Create new position
    socket.on("position:create", async (data, callback) => {
        try {
            const position = await db.position.create(data);
            const populatedPosition = await db.position.findById(position._id);
            callback({ status: "success", message: "Position created successfully", payload: populatedPosition });
            
            // Broadcast to all connected clients
            io.emit("position:created", populatedPosition);
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    // Update position
    socket.on("position:update", async ({ _id, ...data }, callback) => {
        try {
            const position = await db.position.findByIdAndUpdate(_id, { $set: data }, { new: true });
            if (!position) {
                return callback({ status: "error", message: "Position not found" });
            }
            callback({ status: "success", message: "Position updated successfully", payload: position });
            
            // Broadcast to all connected clients
            io.emit("position:updated", position);
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    // Delete position
    socket.on("position:delete", async (_id, callback) => {
        try {
            const result = await db.position.deleteOne({ _id });
            if (result.deletedCount === 0) {
                return callback({ status: "error", message: "Position not found" });
            }
            callback({ status: "success", message: "Position deleted successfully" });
            
            // Broadcast to all connected clients
            io.emit("position:deleted", { _id });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    // Get single position
    socket.on("position:get", async (data, callback) => {
        try {
            const position = await db.position.findOne(data);
            callback({ status: "success", message: "Position fetched successfully", payload: position });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    // Get all positions
    socket.on("positions:get", async (query, callback) => {
        try {
            const positions = await db.position.find(query);
            callback({ status: "success", message: "Positions fetched successfully", payload: positions });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    // Get positions by department
    socket.on("positions:getByDepartment", async (departmentId, callback) => {
        try {
            const positions = await db.position.find({ department: departmentId });
            callback({ status: "success", message: "Positions fetched successfully", payload: positions });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

};
