const mongoose = require("mongoose");
const database = require("../config/database");

const timecardSchema = new mongoose.Schema({
    employee: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "employee",
        required: true
    },
    date: {
        type: Date,
        required: true
    },
    timeIn: {
        type: Date,
        default: () => new Date
    },
    timeOut: {
        type: Date,
        default: null
    },
    breaks: [{
        start: Date,
        end: Date,
        duration: Number
    }],
    totalHours: {
        type: Number,
        default: 0
    },
    totalBreaks: {
        type: Number,
        default: 0
    },
    totalWorkHours: {
        type: Number,
        default: 0
    },
    status: {
        type: String,
        enum: ["Draft", "Pending", "Approved", "Rejected"],
        default: "Draft"
    },
    review: {
        authorizer: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "user"
        },
        date: Date,
        note: String
    },
    note: {
        type: String,
        default: ""
    },
    isDeleted: {
        type: Boolean,
        default: false
    }
}, {
    timestamps: true
});

const Timecard = database.model("timecard", timecardSchema);

module.exports = Timecard;

