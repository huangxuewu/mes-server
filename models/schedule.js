const mongoose = require("mongoose");
const { io } = require("../socket/io");
const database = require("../config/database");

const scheduleSchema = new mongoose.Schema({

});

module.exports = mongoose.model("Schedule", scheduleSchema,"schedule");
