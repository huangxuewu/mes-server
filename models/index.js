const fs = require('fs');
const path = require('path');

module.exports = Object.assign({}, ...fs.readdirSync(__dirname)
    .filter(file => file !== 'index.js')
    .map(file => ({
        [path.parse(file).name]: require(path.join(__dirname, file))
    })));