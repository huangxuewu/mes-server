const mongoose = require("mongoose");
const database = require("../config/database");

const visitorSchema = new mongoose.Schema({
    hostId: { type: mongoose.Schema.Types.ObjectId, ref: "employee", required: true },
    hostName: { type: String, required: true },
    hostPosition: { type: String, default: "" },
    visitorName: { type: String, required: true, trim: true },
    companyName: { type: String, required: true, trim: true },
    photo: { type: String, default: null },
    signInTime: { type: Date, required: true, default: Date.now },
    signOutTime: { type: Date, default: null },
}, {
    timestamps: true,
});

visitorSchema.index({ signOutTime: 1, signInTime: -1 });

module.exports = database.model("Visitor", visitorSchema, "visitor");
