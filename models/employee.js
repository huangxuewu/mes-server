const mongoose = require("mongoose");
const database = require("../config/database");

const employeeSchema = new mongoose.Schema({
    badgeNumber: {
        type: String
    },
    firstName: {
        type: String,
        required: true,
        trim: true,
        maxlength: 50,
    },
    lastName: {
        type: String,
        required: true,
    },
    displayName: {
        type: String
    },
    pin: {
        type: String,
        required: true,
        validate: {
            validator: pin => pin.length === 6,
            message: "PIN must be 6 digits"
        }
    },
    prefferedLanguage: {
        type: String,
        enum: ["en", "zh", "sp"],
        default: "en"
    },
    dob: {
        type: Date,


        required: true,
        validate: {
            validator: dob => dob < new Date(new Date().setFullYear(new Date().getFullYear() - 18)),
            message: "Employee must be at least 18 years old"
        }
    },
    gender: {
        type: String,
        required: true,
        enum: ["male", "female"]
    },
    phone: {
        type: String,
        required: true,
        validate: {
            validator: phone => phone.length === 10,
            message: "Phone number must be 10 digits"
        }
    },
    email: String,
    password: String,
    department: {
        type: String,
        required: true,
        enum: ["Office", "Quality Control", "Logistic", "Sales", "Warehouse", "Production", "Finance", "Security", "Other"]
    },
    position: {
        type: String,
        required: true,
        enum: ["Admin", "Owner", "Manager", "Supervisor", "Staff", "Operator", "Other"]
    },
    skills: [{
        name: String,
        level: {
            type: String,
            enum: ["Beginner", "Intermediate", "Advanced", "Expert"]
        }
    }],
    certifications: [{
        name: String,
        issuer: String,
        expirationDate: Date,
        imageFile: String,
    }],
    employeeStatus: {
        type: String,
        enum: ["Active", "On Leave", "Resigned", "Terminated"],
        default: "Active"
    },
    contact: {
        phone: String,
        address: String,
        email: String,
        emgergency: {
            name: String,
            phone: String,
            relationship: String
        }
    },
    isDeleted: {
        type: Boolean,
        default: false
    }
}, {
    timestamps: true
});


const Employee = database.model("employee", employeeSchema);

employeeSchema.virtual("fullName").get(function () {
    return `${this.firstName} ${this.lastName}`;
});

employeeSchema.virtual("age").get(function () {
    return new Date().getFullYear() - this.dob.getFullYear();
});

module.exports = Employee;
