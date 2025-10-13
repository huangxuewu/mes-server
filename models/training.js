const mongoose = require("mongoose");
const { io } = require("../socket/io");
const database = require("../config/database");

const trainingSchema = new mongoose.Schema({

});

const Training = database.model("training", trainingSchema, "training");

Training.watch([], { fullDocument: "updateLookup" })
    .on("change", (change) => {
        switch (change.operationType) {
            case "insert":
            case "update":
            case "replace":
                io.emit("training:update", change.fullDocument);
                break;
                
            case "delete":
                io.emit("training:delete", change.documentKey._id);
                break;
        }
    });

module.exports = Training;