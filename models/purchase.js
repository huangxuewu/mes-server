const mongoose = require("mongoose");
require("../socket/io");
const database = require("../config/database");

const purchaseSchema = new mongoose.Schema({

});

module.exports = database.model("Purchase", purchaseSchema,"purchase");
