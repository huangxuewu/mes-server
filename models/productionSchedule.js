const mongoose = require("mongoose");
const database = require("../config/database");

const assignmentSchema = new mongoose.Schema({
    departmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'department', required: true },
    styleCode: { type: String, required: true },
    teamId: { type: mongoose.Schema.Types.ObjectId, ref: 'team', required: true },
    quantity: { type: Number, required: true, min: 0 },
}, { _id: false });

const productionScheduleSchema = new mongoose.Schema({
    date: { type: String, required: true },
    assignments: { type: [assignmentSchema], default: [] },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'user', default: null },
}, {
    timestamps: true,
});

productionScheduleSchema.index({ date: 1 }, { unique: true });

module.exports = database.model("productionSchedule", productionScheduleSchema, "productionSchedule");
