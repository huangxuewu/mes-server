const mongoose = require("mongoose");
const { io } = require("../socket/io");
const database = require("../config/database");

const purchaseSchema = new mongoose.Schema({

});

module.exports = mongoose.model("Purchase", purchaseSchema,"purchase");
