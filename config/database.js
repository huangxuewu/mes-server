const mongoose = require("mongoose");
const URI = `mongodb+srv://downhome:5774615@downhome.hqyh8h4.mongodb.net/Greenwood?retryWrites=true&w=majority&appName=DownHome`;

// Disable pluralization
mongoose.pluralize(null);

mongoose.connect(URI);
mongoose.connection.on("connected", () => console.log('Database connected'));
mongoose.connection.on("error", error => console.log('Mongoose connect error: ', error));
mongoose.connection.on("disconnected", () => console.log('Database has disconnected'));

process.on('SIGINT', () =>{
    console.log('Application terminated');
    mongoose.connection.close();
    process.exit(0);
});


module.exports = mongoose;