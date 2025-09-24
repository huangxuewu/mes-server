const mongoose = require("mongoose");
const { io } = require("../socket/io");
const database = require("../config/database");

/**
 * Simple Production Log Schema for MES
 */
const productionLogSchema = new mongoose.Schema({
    logNumber: { 
        type: String, 
        required: true, 
        unique: true 
    },
    
    // References
    productionPlanId: { type: mongoose.Schema.Types.ObjectId, ref: 'productionPlan', required: true },
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'order', required: true },
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'product', required: true },
    
    // Basic Information
    logDate: { type: Date, required: true, default: Date.now },
    shift: { 
        type: String, 
        enum: ['Day', 'Evening', 'Night'],
        required: true 
    },
    
    // Production Details
    plannedQuantity: { type: Number, required: true },
    actualQuantity: { type: Number, required: true },
    goodQuantity: { type: Number, required: true },
    rejectedQuantity: { type: Number, default: 0 },
    unit: { type: String, required: true, default: 'pcs' },
    
    // Time Tracking
    startTime: { type: Date, required: true },
    endTime: Date,
    plannedDuration: { type: Number, required: true }, // in minutes
    actualDuration: { type: Number, default: 0 }, // in minutes
    
    // Personnel
    operator: { type: mongoose.Schema.Types.ObjectId, ref: 'employee', required: true },
    supervisor: { type: mongoose.Schema.Types.ObjectId, ref: 'employee' },
    
    // Quality Check
    qualityCheck: {
        result: { type: String, enum: ['Pass', 'Fail'], default: 'Pass' },
        inspector: { type: mongoose.Schema.Types.ObjectId, ref: 'employee' },
        checkedAt: { type: Date, default: Date.now },
        notes: String
    },
    
    // Downtime
    downtimeMinutes: { type: Number, default: 0 },
    downtimeReason: String,
    
    // Performance
    efficiency: { type: Number, default: 0 }, // percentage
    yield: { type: Number, default: 0 }, // percentage
    
    // Status
    status: { 
        type: String, 
        enum: ['In Progress', 'Completed', 'On Hold'],
        default: 'In Progress'
    },
    
    // Notes
    notes: String,
    issues: [String],
    
    // Audit
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'employee' }
}, { 
    timestamps: true 
});

/**
 * Auto-generate log number and calculate metrics
 */
productionLogSchema.pre('save', async function(next) {
    // Generate log number if new
    if (this.isNew && !this.logNumber) {
        const today = new Date().toISOString().split('T')[0].replace(/-/g, '');
        const count = await this.constructor.countDocuments({
            logDate: { $gte: new Date(today), $lt: new Date(today + 'T23:59:59.999Z') }
        });
        this.logNumber = `PL-${today}-${String(count + 1).padStart(3, '0')}`;
    }
    
    // Calculate actual duration if end time is set
    if (this.endTime && this.startTime) {
        this.actualDuration = Math.round((this.endTime - this.startTime) / (1000 * 60)); // in minutes
    }
    
    // Calculate efficiency
    if (this.plannedDuration > 0 && this.actualDuration > 0) {
        this.efficiency = Math.round((this.plannedDuration / this.actualDuration) * 100);
    }
    
    // Calculate yield
    if (this.actualQuantity > 0) {
        this.yield = Math.round((this.goodQuantity / this.actualQuantity) * 100);
    }
    
    next();
});

/**
 * Complete the production log
 */
productionLogSchema.methods.completeLog = function(endTime, notes = '') {
    this.endTime = endTime || new Date();
    this.status = 'Completed';
    if (notes) this.notes = notes;
    return this.save();
};

/**
 * Add quality check
 */
productionLogSchema.methods.addQualityCheck = function(result, inspector, notes = '') {
    this.qualityCheck = {
        result,
        inspector,
        checkedAt: new Date(),
        notes
    };
    return this.save();
};

/**
 * Record downtime
 */
productionLogSchema.methods.recordDowntime = function(minutes, reason = '') {
    this.downtimeMinutes = minutes;
    this.downtimeReason = reason;
    return this.save();
};

/**
 * Get logs by production plan
 */
productionLogSchema.statics.getByProductionPlan = function(productionPlanId) {
    return this.find({ productionPlanId })
        .populate('productionPlanId orderId productId operator supervisor')
        .sort({ logDate: -1, startTime: -1 });
};

/**
 * Get logs by operator
 */
productionLogSchema.statics.getByOperator = function(operatorId, startDate, endDate) {
    const query = { operator: operatorId };
    if (startDate && endDate) {
        query.logDate = { $gte: startDate, $lte: endDate };
    }
    
    return this.find(query)
        .populate('productionPlanId orderId productId operator supervisor')
        .sort({ logDate: -1, startTime: -1 });
};

/**
 * Get daily production summary
 */
productionLogSchema.statics.getDailySummary = function(date) {
    const startOfDay = new Date(date);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(date);
    endOfDay.setHours(23, 59, 59, 999);
    
    return this.aggregate([
        {
            $match: {
                logDate: { $gte: startOfDay, $lte: endOfDay },
                status: 'Completed'
            }
        },
        {
            $group: {
                _id: null,
                totalPlannedQuantity: { $sum: '$plannedQuantity' },
                totalActualQuantity: { $sum: '$actualQuantity' },
                totalGoodQuantity: { $sum: '$goodQuantity' },
                totalRejectedQuantity: { $sum: '$rejectedQuantity' },
                totalDowntime: { $sum: '$downtimeMinutes' },
                averageEfficiency: { $avg: '$efficiency' },
                averageYield: { $avg: '$yield' },
                totalLogs: { $sum: 1 }
            }
        }
    ]);
};

const ProductionLog = database.model("productionLog", productionLogSchema, "productionLog");

// Socket.io change stream
ProductionLog.watch([], { fullDocument: "updateLookup" })
    .on("change", (change) => {
        switch (change.operationType) {
            case "insert":
            case "update":
            case "replace":
                io.emit("productionLog:update", change.fullDocument);
                break;
            case "delete":
                io.emit("productionLog:delete", change.documentKey._id);
                break;
        }
    });

module.exports = ProductionLog;