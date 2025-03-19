const mongoose = require("mongoose");
const database = require("../config/database");

const enrollmentSchema = new mongoose.Schema({
    portrait: String,
    applyPosition: String,
    workType: String,
    payType: String,
    desiredPayRate: String,
    firstName: String,
    lastName: String,
    nickName: String,
    email: String,
    cellphone: String,
    telephone: String,
    address: String,
    city: String,
    state: String,
    zip: String,
    country: String,
    dateOfBirth: String,
    gender: String,
    referrer: String,
    bankName: String,
    accountNumber: String,
    routingNumber: String,
    confirmRoutingNumber: String,
    emergencyContactName: String,
    emergencyContactPhone: String,
    emergencyContactRelationship: String,
    workHistory: [
        {
            companyName: String,
            position: String,
            startDate: String,
            endDate: String,
            reason: String
        }
    ],
    interview: {
        status: String,
        date: String,
        time: Date,
        interviewer: String,
        comment: String,
        asking: Number, // in dollars
        offering: Number, // in dollars
    },
    eVerify: {
        status: String,
        caseNumber: String,
        comment: String,
    },
    status: String,
    isDeleted: Boolean,
    isActive: Boolean,
    isHired: Boolean,
    hiredAt: Date,
    hiredBy: String,
    comments: []
}, { timestamps: true });

const Enrollment = mongoose.model("Enrollment", enrollmentSchema);

module.exports = Enrollment;
