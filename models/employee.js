const mongoose = require("mongoose");
const { io } = require("../socket/io");
const database = require("../config/database");

const { Schema } = mongoose;

const emergencySchema = new Schema({
    phone: { type: String },
    contact: { type: String },
    relationship: { type: String },
    note: { type: String }
}, { _id: false });

const personalSchema = new Schema({
    ssn: { type: String },
    dob: { type: Date },
    race: { type: String },
    gender: { type: String },
    address: { type: String },
    city: { type: String },
    state: { type: String },
    email: { type: String },
    cellphone: { type: String },
    maritalStatus: { type: String, default: "Single" },
    immigrationStatus: { type: String },
    driverLicense: { type: String }
}, { _id: false });

const preferredSchema = new Schema({
    payType: { type: String, enum: ["Hourly", "Salary"], default: "Hourly" },
    workType: { type: String, enum: ["Full Time", "Part Time"], default: "Full Time" },
    payRate: { type: Number },
    position: { type: String },
    language: { type: String, default: "English" }
}, { _id: false });

const workHistorySchema = new Schema({
    company: { type: String },
    position: { type: String },
    startDate: { type: Date },
    endDate: { type: Date },
    payRate: { type: Number },
    reason: { type: String },
    notes: { type: String }
}, { _id: false });

const documentLinksSchema = new Schema({
    // List A
    "U.S. Passport": { type: String },
    "U.S. Passport Card": { type: String },
    "Green Card": { type: String },
    "Foreign Passport with I-94": { type: String },
    "Employment Authorization Document": { type: String },
    "Refugee I-94": { type: String },
    "Asylee I-94": { type: String },
    "TPS I-766": { type: String },
    "DACA I-766": { type: String },
    "Student I-20/DS-2019": { type: String },

    // List B
    "Driver License": { type: String },
    "State ID Card": { type: String },
    "Military ID": { type: String },
    "Military Dependent ID": { type: String },
    "Native American Tribal Document": { type: String },
    "Canadian Driver License": { type: String },
    "School ID with Photo": { type: String },

    // List C
    "Social Security Card": { type: String },
    "Birth Certificate": { type: String },
    "U.S. Citizen ID Card": { type: String },
    "Native American Tribal Document": { type: String },
    "Employment Authorization Card": { type: String },
    "Temporary Resident Card": { type: String },
    "Reentry Permit": { type: String },
    "Refugee Travel Document": { type: String },
    "Employment Authorization Document (List C)": { type: String }
}, { _id: false });

const timecardSchema = new Schema({
    _id: { type: mongoose.Schema.Types.ObjectId, ref: "timecard" },
    date: { type: String },
    status: { type: String, enum: ["Clocked In", "Clocked Out", "On Break"], default: "Clocked In" },
    disabled: { type: Boolean, default: false }
});

const employeeSchema = new Schema({
    portrait: { type: String }, // url
    firstName: { type: String, required: true },
    lastName: { type: String, required: true },
    displayName: { type: String },
    department: { type: String },
    role: { type: String },
    pin: { type: String },

    personal: personalSchema,
    preferred: preferredSchema,
    emergency: emergencySchema,
    documents: documentLinksSchema,
    workHistory: [workHistorySchema],
    timecard: timecardSchema,

    status: { type: String, enum: ["Draft", "Pending", "Probation", "Active", "Inactive"], default: "Draft" }
}, { timestamps: true });


employeeSchema.virtual("fullName").get(function () {
    return `${this.firstName} ${this.lastName}`;
});

employeeSchema.virtual("age").get(function () {
    return new Date().getFullYear() - this.dob.getFullYear();
});

employeeSchema.methods.clockIn = async function (timecardId) {
    const employee = await this.model("employee").findByIdAndUpdate(this._id, {
        timecard: {
            _id: timecardId,
            date: new Date().toISOString().split('T')[0],
            status: "Clocked In",
            disabled: false
        }
    }, { new: true });

    return employee;
}

const Employee = database.model("employee", employeeSchema, 'employee');

Employee.watch([], { fullDocument: "updateLookup" })
    .on("change", (change) => {
        switch (change.operationType) {
            case "insert":
            case "update":
            case "replace":
                io.emit("employee:update", change.fullDocument);
                break;

            case "delete":
                io.emit("employee:delete", change.documentKey._id);
                break;
        }
    });

module.exports = Employee;
