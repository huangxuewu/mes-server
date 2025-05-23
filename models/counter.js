const mongoose = require("mongoose");
const { io } = require("../socket/io");
const database = require("../config/database");

const counter = new mongoose.Schema({
    _id: {
        type: String,
        required: true,
        description: "Pallet ID Format PLT-YYMMDD"
    },
    sequence: {
        type: Number,
        default: 0,
    }
});

const Counter = database.model("Counter", counter, "counter");

module.exports = Counter;