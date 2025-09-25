const mongoose = require("mongoose");
const database = require("../config/database");
const { io } = require("../socket/io");

const departmentSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        unique: true
    },
    description: String,
    manager: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'position'
    },
    parent: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'department'
    },
    status: {
        type: String,
        enum: ["Active", "Inactive"],
        default: "Active"
    }
}, {
    timestamps: true
});


const Department = database.model("department", departmentSchema, 'department');

/**
 * Change stream to emit via socket.io
 */
Department.watch([], { fullDocument: "updateLookup" })
    .on("change", (change) => {
        switch (change.operationType) {
            case "insert":
            case "update":
            case "replace":
                io.emit("department:update", change.fullDocument);
                break;
            case "delete":
                io.emit("department:delete", change.documentKey._id);
                break;
        }
    });

module.exports = Department;
