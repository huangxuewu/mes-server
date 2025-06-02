const mongoose = require("mongoose");
const { io } = require("../socket/io");
const database = require("../config/database");

const productionLog = new mongoose.Schema({
    date: String,
    from: Date,
    to: Date,

})

const scheduleSchema = new mongoose.Schema({
    scheduleFrom: Date,
    scheduleTo: Date,
    quantity: Number,
    logs: [productionLog]
});

module.exports = mongoose.model("Schedule", scheduleSchema, "schedule");
