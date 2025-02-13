const mongoose = require("mongoose");
const database = require("../config/database");

const timecardSchema = new mongoose.Schema({
    employee: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "employee",
        required: true
    },
    date: {
        type: String,
        required: true
    },
    timeIn: {
        type: Date,
        default: () => new Date
    },
    timeInImage: {
        type: String,
        default: null
    },
    timeOut: {
        type: Date,
        default: null
    },
    timeOutImage: {
        type: String,
        default: null
    },
    breaks: [{
        start: Date,
        end: Date,
        duration: {
            type: Number,
            default: 0
        },
        startImage: {
            type: String,
            default: null
        },
        endImage: {
            type: String,
            default: null
        }
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
        default: "Pending"
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

timecardSchema.methods.breakStart = async function (imageURL) {
    this.breaks.push({
        start: new Date(),
        startImage: imageURL
    });

    await this.save();

    return this;
}

module.exports = database.model("timecard", timecardSchema, 'timecard');

