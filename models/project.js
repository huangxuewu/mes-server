const mongoose = require("mongoose");
const database = require("../config/database");
const { io } = require("../socket/io");

const quoteSchema = new mongoose.Schema({
    vendor: { type: String, default: "", trim: true },
    company: {
        name: { type: String, default: "", trim: true },
        contactName: { type: String, default: "", trim: true },
        email: { type: String, default: "", trim: true },
        phone: { type: String, default: "", trim: true },
        address: { type: String, default: "", trim: true },
    },
    amount: { type: Number, default: 0, min: 0 },
    leadTime: { type: String, default: "", trim: true },
    status: { type: String, default: "Quoted", trim: true },
    submittedAt: { type: Date, default: null },
    projectInfo: {
        scope: { type: String, default: "", trim: true },
        notes: { type: String, default: "", trim: true },
        projectId: { type: String, default: "", trim: true },
        projectName: { type: String, default: "", trim: true },
    },
    files: {
        quote: { type: String, default: "", trim: true },
        contract: { type: String, default: "", trim: true },
        serviceTerm: { type: String, default: "", trim: true },
    },
}, { _id: false });

const selectedQuoteSchema = new mongoose.Schema({
    vendor: { type: String, default: "", trim: true },
    amount: { type: Number, default: 0, min: 0 },
    leadTime: { type: String, default: "", trim: true },
}, { _id: false });

const approvalTimelineSchema = new mongoose.Schema({
    at: { type: Date, default: Date.now },
    actor: { type: String, default: "", trim: true },
    action: { type: String, default: "", trim: true },
    message: { type: String, default: "", trim: true },
    images: [{ type: String, trim: true }],
}, { _id: false });

const approvalSchema = new mongoose.Schema({
    id: { type: String, default: "", trim: true },
    summary: { type: String, default: "", trim: true },
    requestedAt: { type: Date, default: null },
    requester: { type: String, default: "", trim: true },
    status: { type: String, default: "Pending", trim: true },
    timeline: { type: [approvalTimelineSchema], default: [] },
}, { _id: false });

const milestoneImageSchema = new mongoose.Schema({
    src: { type: String, default: "", trim: true },
    alt: { type: String, default: "", trim: true },
}, { _id: false });

const milestoneSchema = new mongoose.Schema({
    at: { type: Date, default: null },
    title: { type: String, default: "", trim: true },
    note: { type: String, default: "", trim: true },
    images: { type: [milestoneImageSchema], default: [] },
}, { _id: false });

const projectSchema = new mongoose.Schema({
    id: { type: String, required: true, unique: true, trim: true },
    name: { type: String, required: true, trim: true },
    type: { type: String, default: "", trim: true },
    problem: { type: String, default: "", trim: true },
    goal: { type: String, default: "", trim: true },
    area: { type: String, default: "", trim: true },
    contractor: { type: String, default: "", trim: true },
    budget: { type: Number, default: 0, min: 0 },
    status: { type: String, default: "Draft", trim: true },
    quotes: { type: [quoteSchema], default: [] },
    selectedQuote: { type: selectedQuoteSchema, default: () => ({}) },
    approvals: { type: [approvalSchema], default: [] },
    milestones: { type: [milestoneSchema], default: [] },
    fileSummary: {
        document: { type: Number, default: 0, min: 0 },
        image: { type: Number, default: 0, min: 0 },
        invoice: { type: Number, default: 0, min: 0 },
    },
    dropboxPath: { type: String, default: "", trim: true },
}, { timestamps: true });

projectSchema.index({ status: 1, updatedAt: -1 });
projectSchema.index({ name: 1 });

const Project = database.model("project", projectSchema, "project");

Project.watch([], { fullDocument: "updateLookup" })
    .on("change", (change) => {
        switch (change.operationType) {
            case "insert":
            case "update":
            case "replace":
                io.emit("project:update", change.fullDocument);
                break;
            case "delete":
                io.emit("project:delete", change.documentKey._id);
                break;
        }
    });

module.exports = Project;
