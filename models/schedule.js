const mongoose = require("mongoose");
const { io } = require("../socket/io");
const database = require("../config/database");

const productionLog = new mongoose.Schema({
    date: String,
    from: Date,
    to: Date,

})

const scheduleSchema = new mongoose.Schema({
    date:String,
    quantity: Number,
    shift: String,
    logs: [productionLog]
});

module.exports = database.model("schedule", scheduleSchema, "schedule");
