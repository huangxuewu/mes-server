const mongoose = require("mongoose");
const database = require("../config/database");

const productSchema = new mongoose.Schema({
    name: String,
    price: Number,
    stock: Number,
    image: String,
    description: String,
    category: String,
    brand: String,
    model: String,
    color: String,
    size: String,
    weight: String,
    material: String,
});

const configSchema = new mongoose.Schema({
    manufacturer: {
        name: String,
        address: String,
        phone: String,
        email: String,
        website: String,
    },
    product: [productSchema],
});

module.exports = database.model("config", configSchema, 'config');

