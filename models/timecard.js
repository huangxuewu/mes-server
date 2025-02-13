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

    // update employee timecard status
    await this.model("employee").updateOne({ _id: this.employee._id }, { $set: { 'timecard.status': "On Break" } });

    return this;
}

timecardSchema.methods.breakEnd = async function (imageURL) {
    const lastBreak = this.breaks[this.breaks.length - 1];
    lastBreak.end = new Date();
    lastBreak.endImage = imageURL;
    // calculate duration in minutes
    lastBreak.duration = Math.round((lastBreak.end.getTime() - lastBreak.start.getTime()) / 60000);

    await this.save();

    // update employee timecard status
    await this.model("employee").updateOne({ _id: this.employee._id }, { $set: { 'timecard.status': "Clocked In" } });

    return this;
}

timecardSchema.methods.clockOut = async function (imageURL) {
    this.timeOut = new Date();
    this.timeOutImage = imageURL;

    // calculate total hours in minutes 
    this.totalHours = Math.round((this.timeOut.getTime() - this.timeIn.getTime()) / 60000);
    // calculate total breaks in minutes
    this.totalBreaks = this.breaks.reduce((acc, breakObj) => acc + breakObj.duration, 0);
    // calculate total work hours in minutes
    this.totalWorkHours = this.totalHours - this.totalBreaks;

    await this.save();

    // update employee timecard status
    await this.model("employee").updateOne({ _id: this.employee._id }, { $set: { 'timecard.status': "Clocked Out" } });

    return this;
}

module.exports = database.model("timecard", timecardSchema, 'timecard');

