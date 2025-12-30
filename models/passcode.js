const mongoose = require("mongoose");
const { io } = require("../socket/io");
const database = require("../config/database");
const { encryptString } = require("../utils/passcodeCrypto");

const passcodeSchema = new mongoose.Schema({
    type: {
        type: String,
        enum: ["ACCOUNT", "PIN"],
        default: "ACCOUNT",
    },
    purpose: {
        type: String,
        default: "",
    },
    website: {
        type: String,
        default: "",
    },
    username: {
        type: String,
        default: "",
    },
    password: {
        type: String,
        default: "",
    },
    pin: {
        type: String,
        default: "",
    },
    note: {
        type: String,
        default: "",
    },
    visibility: {
        type: String,
        enum: ["PUBLIC", "PRIVATE"],
        default: "PUBLIC",
    },
    createdBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        required: true,
    }
}, {
    timestamps: true,
});

// Encrypt on create/save (covers db.passcode.create(...) and doc.save())
passcodeSchema.pre("save", function (next) {
    try {
        if (this.isModified("password")) this.password = encryptString(this.password);
        if (this.isModified("pin")) this.pin = encryptString(this.pin);
        next();
    } catch (err) {
        next(err);
    }
});

// Encrypt on update queries (covers findByIdAndUpdate / findOneAndUpdate / updateOne / updateMany)
function encryptUpdate(update) {
    if (!update) return update;

    // Support both { $set: {...} } and direct updates { password: "x" }
    const $set = update.$set ? { ...update.$set } : null;

    const target = $set || update;
    if (Object.prototype.hasOwnProperty.call(target, "password")) {
        target.password = encryptString(target.password);
    }
    if (Object.prototype.hasOwnProperty.call(target, "pin")) {
        target.pin = encryptString(target.pin);
    }

    if ($set) update.$set = target;
    return update;
}

passcodeSchema.pre(["findOneAndUpdate", "updateOne", "updateMany"], function (next) {
    try {
        const update = this.getUpdate();
        this.setUpdate(encryptUpdate(update));
        next();
    } catch (err) {
        next(err);
    }
});

// // Convenience instance method (server-side) if you ever need decrypted values
// passcodeSchema.methods.decryptSensitive = function () {
//     return {
//         password: decryptString(this.password),
//         pin: decryptString(this.pin),
//     };
// };

// // Convenience helper to decrypt a whole payload/object
// passcodeSchema.statics.decryptFields = function (passcodeLike) {
//     return decryptPasscodeFields(passcodeLike);
// };

const Passcode = database.model("Passcode", passcodeSchema, "passcode");

Passcode.watch([], { fullDocument: "updateLookup" })
    .on("change", (change) => {
        switch (change.operationType) {
            case "insert":
            case "update":
            case "replace":
                io.emit("passcode:update", change.fullDocument);
                break;
            case "delete":
                io.emit("passcode:delete", change.documentKey._id);
                break;
        }
    });

module.exports = Passcode;