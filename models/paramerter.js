const mongoose = require("mongoose");
const { io } = require("../socket/io");
const database = require("../config/database");

const settingSchema = new mongoose.Schema({
    name: String,
    description: String,
    value: String,
})

const parameterSchema = new mongoose.Schema({
    lineId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Line"
    },
    name: String,
    description: String,
    outputPerMinute: Number,
    settings: [settingSchema]
})

const Parameter = database.model("Parameter", parameterSchema, "parameter");

Parameter.watch([], { fullDocument: "updateLookup" })
    .on("change", (change) => {
        switch (change.operationType) {
            case "insert":
            case "update":
            case "replace":
                io.emit("parameter:update", change.fullDocument);   
                break;
            case "delete":
                io.emit("parameter:delete", change.documentKey._id);
                break;
        }
    })

module.exports = Parameter;