const mongoose = require("mongoose");
const { io } = require("../socket/io");
const database = require("../config/database");

/**
 * Daily Production Plan Schema for MES
 */
const productionPlanSchema = new mongoose.Schema({
    planNumber: {
        type: String,
        required: true,
        unique: true
    },

    // Daily Plan Information
    planDate: { type: Date, required: true }, // The specific day this plan is for
    shift: {
        type: String,
        enum: ['Day', 'Evening', 'Night'],
        required: true
    },

    // Basic Information
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'order', required: true },
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'product', required: true },
    productName: { type: String, required: true },

    // Daily Production Details
    targetQuantity: { type: Number, required: true }, // How many to produce today
    actualQuantity: { type: Number, default: 0 }, // How many actually produced
    unit: { type: String, required: true, default: 'pcs' },

    // Daily Schedule
    plannedStartTime: { type: Date, required: true }, // When to start today
    plannedEndTime: { type: Date, required: true }, // When to finish today
    actualStartTime: Date,
    actualEndTime: Date,

    // Production Line
    lineId: { type: mongoose.Schema.Types.ObjectId, ref: 'line' },
    lineName: String,

    // Status
    status: {
        type: String,
        enum: ['Draft', 'Scheduled', 'In Progress', 'Completed', 'Cancelled'],
        default: 'Draft'
    },

    // Progress (0-100%)
    progress: { type: Number, default: 0, min: 0, max: 100 },

    // Notes
    notes: String,

    // Who created and manages this daily plan
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'employee' },
    assignedTo: [{ type: mongoose.Schema.Types.ObjectId, ref: 'employee' }]
}, {
    timestamps: true
});

/**
 * Auto-generate daily plan number
 */
productionPlanSchema.pre('save', async function (next) {
    if (this.isNew && !this.planNumber) {
        const dateStr = this.planDate.toISOString().split('T')[0].replace(/-/g, '');
        const count = await this.constructor.countDocuments({
            planDate: { $gte: new Date(dateStr), $lt: new Date(dateStr + 'T23:59:59.999Z') }
        });
        this.planNumber = `DP-${dateStr}-${String(count + 1).padStart(3, '0')}`;
    }
    next();
});

/**
 * Update progress when actual quantity changes
 */
productionPlanSchema.methods.updateProgress = function () {
    if (this.targetQuantity > 0) {
        this.progress = Math.round((this.actualQuantity / this.targetQuantity) * 100);

        // Auto-complete if target reached
        if (this.progress >= 100 && this.status === 'In Progress') {
            this.status = 'Completed';
            this.actualEndDate = new Date();
        }
    }
    return this.save();
};

/**
 * Start daily production
 */
productionPlanSchema.methods.startProduction = function () {
    this.status = 'In Progress';
    this.actualStartTime = new Date();
    return this.save();
};

/**
 * Get active daily production plans
 */
productionPlanSchema.statics.getActivePlans = function () {
    return this.find({
        status: { $in: ['Scheduled', 'In Progress'] }
    }).populate('orderId productId lineId createdBy assignedTo');
};

/**
 * Get daily production plans for a specific date
 */
productionPlanSchema.statics.getDailyPlans = function (date) {
    const startOfDay = new Date(date);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(date);
    endOfDay.setHours(23, 59, 59, 999);

    return this.find({
        planDate: { $gte: startOfDay, $lte: endOfDay }
    }).populate('orderId productId lineId createdBy assignedTo');
};

/**
 * Get today's production plans
 */
productionPlanSchema.statics.getTodayPlans = function () {
    const today = new Date();
    return this.getDailyPlans(today);
};

const ProductionPlan = database.model("productionPlan", productionPlanSchema, "productionPlan");

// Socket.io change stream
ProductionPlan.watch([], { fullDocument: "updateLookup" })
    .on("change", (change) => {
        switch (change.operationType) {
            case "insert":
            case "update":
            case "replace":
                io.emit("productionPlan:update", change.fullDocument);
                break;
            case "delete":
                io.emit("productionPlan:delete", change.documentKey._id);
                break;
        }
    });

module.exports = ProductionPlan;