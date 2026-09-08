const mongoose = require('mongoose');
const database = require('../config/database');
const { io } = require('../socket/io');

const eventSchema = new mongoose.Schema({
    requestId: { type: String, required: true },
    action: { type: String, enum: ['start', 'pause', 'resume', 'end', 'changeCrew', 'issue'], required: true },
    at: { type: Date, required: true },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'user', required: true },
    reason: { type: String, default: '' },
    statusCode: Number,
    byName: String,
    lotNumber: String,
    stopType: { type: String, enum: ['Scheduled', 'Unscheduled'] },
    issueType: { type: String, enum: ['Employee', 'Machine'] },
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'employee' },
    employeeName: String,
}, { _id: false });

const crewSchema = new mongoose.Schema({
    stepId: mongoose.Schema.Types.ObjectId, stepName: String, slotIndex: Number,
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'employee', default: null },
    employeeName: String, enabled: Boolean,
}, { _id: false });

const productionRunSchema = new mongoose.Schema({
    lineId: { type: mongoose.Schema.Types.ObjectId, ref: 'line', required: true },
    lineName: String,
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'product', required: true },
    productName: String,
    styleCode: String,
    letterCode: String,
    clientName: String,
    profileId: { type: mongoose.Schema.Types.ObjectId, ref: 'Parameter', default: null },
    profileName: String,
    settings: [{ key: String, value: String, _id: false }],
    schedule: { date: String, styleCode: String, departmentId: mongoose.Schema.Types.ObjectId, teamId: mongoose.Schema.Types.ObjectId, quantity: Number },
    crew: [crewSchema],
    lotNumber: String,
    lots: [{ number: { type: String, required: true }, startedAt: { type: Date, required: true }, endedAt: { type: Date, default: null },
        by: { type: mongoose.Schema.Types.ObjectId, ref: 'user' }, reason: String, crew: [crewSchema], _id: false }],
    packaging: { boxesPerPallet: Number, bagsPerBox: Number, pillowsPerBag: Number },
    businessDate: { type: String, required: true },
    timeZone: { type: String, required: true },
    startedAt: { type: Date, required: true },
    endedAt: { type: Date, default: null },
    status: { type: String, enum: ['Running', 'Paused', 'Ended'], required: true },
    open: { type: Boolean, required: true },
    revision: { type: Number, default: 0 },
    startRequestId: { type: String, required: true },
    events: { type: [eventSchema], default: [] },
}, { timestamps: true });

productionRunSchema.index({ lineId: 1 }, { unique: true, partialFilterExpression: { open: true } });
productionRunSchema.index({ startRequestId: 1 }, { unique: true });
productionRunSchema.index({ lineId: 1, startedAt: -1 });
productionRunSchema.index({ 'lots.number': 1 }, { unique: true, partialFilterExpression: { 'lots.number': { $type: 'string' } } });

const ProductionRun = database.model('productionRun', productionRunSchema, 'productionRun');
ProductionRun.watch([], { fullDocument: 'updateLookup' }).on('change', change => {
    if (change.fullDocument) io.emit('productionRun:changed', { lineId: change.fullDocument.lineId });
});

module.exports = ProductionRun;
