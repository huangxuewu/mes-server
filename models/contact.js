const mongoose = require("mongoose");
const database = require("../config/database");
const { io } = require("../socket/io");

const addressSchema = new mongoose.Schema({
    street: { type: String },
    city: { type: String },
    state: { type: String },
    zipCode: { type: String },
    country: { type: String, default: "USA" }
}, { _id: false });

const contactInfoSchema = new mongoose.Schema({
    phone: { type: String },
    email: { type: String },
    fax: { type: String },
    website: { type: String },
    mobile: { type: String }
}, { _id: false });

const businessInfoSchema = new mongoose.Schema({
    companyName: { type: String },
    taxId: { type: String },
    industry: { type: String },
    size: { 
        type: String, 
        enum: ["Small", "Medium", "Large", "Enterprise"],
        default: "Medium"
    },
    establishedYear: { type: Number },
    description: { type: String },
    // Company-level contact management
    companyId: { 
        type: mongoose.Schema.Types.ObjectId, 
        ref: 'contact',
        description: "Reference to the primary company contact"
    }
}, { _id: false });

const contactSchema = new mongoose.Schema({
    // Basic Information
    firstName: { type: String, required: true },
    lastName: { type: String, required: true },
    displayName: { type: String },
    title: { type: String }, // Job title
    department: { type: String },

    // Contact Type
    type: {
        type: String,
        enum: ["Customer", "Supplier", "Vendor", "Partner", "Employee", "Other"],
        required: true,
        default: "Other"
    },

    // Contact Information
    contactInfo: contactInfoSchema,

    // Business Information
    businessInfo: businessInfoSchema,

    // Address Information
    address: addressSchema,

    // Relationship Information
    primaryContact: { type: Boolean, default: false },
    contactRole: {
        type: String,
        enum: ["Primary", "Secondary", "Technical", "Sales", "Support", "Billing", "Shipping", "Other"],
        default: "Other"
    },
    reportsTo: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'contact',
        description: "Reference to another contact in the same company"
    },
    preferredContactMethod: {
        type: String,
        enum: ["Email", "Phone", "Mobile", "Fax"],
        default: "Email"
    },

    // Status and Management
    status: {
        type: String,
        enum: ["Active", "Inactive", "Pending", "Blocked"],
        default: "Active"
    },

    // Additional Information
    notes: { type: String },
    tags: [String], // For categorization
    source: { type: String }, // How this contact was acquired

    // Timestamps
    lastContactDate: { type: Date },
    nextFollowUpDate: { type: Date },

    // Custom Fields
    customFields: {
        type: Map,
        of: mongoose.Schema.Types.Mixed
    }
}, {
    timestamps: true
});

// Virtual for full name
contactSchema.virtual("fullName").get(function () {
    return `${this.firstName} ${this.lastName}`;
});

// Virtual for company display
contactSchema.virtual("companyDisplay").get(function () {
    return this.businessInfo?.companyName || this.displayName || this.fullName;
});

// Pre-save middleware to set displayName if not provided
contactSchema.pre('save', function (next) {
    if (!this.displayName) {
        this.displayName = this.fullName;
    }
    next();
});

// Static method to get all contacts for a company
contactSchema.statics.getCompanyContacts = function(companyId) {
    return this.find({
        $or: [
            { _id: companyId },
            { "businessInfo.companyId": companyId }
        ]
    }).sort({ primaryContact: -1, contactRole: 1, firstName: 1 });
};

// Static method to get primary contact for a company
contactSchema.statics.getPrimaryContact = function(companyName) {
    return this.findOne({
        "businessInfo.companyName": companyName,
        primaryContact: true,
        status: "Active"
    });
};

// Instance method to get related contacts in the same company
contactSchema.methods.getCompanyContacts = function() {
    const Contact = this.constructor;
    return Contact.find({
        $or: [
            { "businessInfo.companyName": this.businessInfo?.companyName },
            { "businessInfo.companyId": this._id },
            { "businessInfo.companyId": this.businessInfo?.companyId }
        ],
        _id: { $ne: this._id }
    }).sort({ primaryContact: -1, contactRole: 1, firstName: 1 });
};

const Contact = database.model("contact", contactSchema, 'contact');

/**
 * Change stream to emit via socket.io
 */
Contact.watch([], { fullDocument: "updateLookup" })
    .on("change", (change) => {
        switch (change.operationType) {
            case "insert":
            case "update":
            case "replace":
                io.emit("contact:update", change.fullDocument);
                break;
            case "delete":
                io.emit("contact:delete", change.documentKey._id);
                break;
        }
    });

module.exports = Contact;
