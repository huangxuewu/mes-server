const fs = require('fs');
const path = require('path');

module.exports = (socket, io) => {
    // Automatically load all handler files
    fs.readdirSync(__dirname)
        .filter(file => file !== 'index.js')
        .forEach(file => {
            require(path.join(__dirname, file))(socket, io);
        });
};