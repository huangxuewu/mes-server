module.exports = (socket, io) => {

    //
    socket.on('employee:get', (data) => {
        console.log(data);
    });

    socket.on('employee:create', (data) => {
        console.log(data);
    });

    socket.on('employee:update', (data) => {
        console.log(data);
    });

    socket.on('employee:delete', (data) => {
        console.log(data);
    });

    // Timecard
    socket.on('timecard:clockIn', (data) => {
        console.log(data);
    });

    socket.on('timecard:clockOut', (data) => {
        console.log(data);
    });

    socket.on('timecard:breakStart', (data) => {
        console.log(data);
    });

    socket.on('timecard:breakEnd', (data) => {
        console.log(data);
    });

    socket.on('timecard:get', (data) => {
        console.log(data);
    });

    socket.on('timecard:update', (data) => {
        console.log(data);
    });

    socket.on('timecard:delete', (data) => {
        console.log(data);
    });

    socket.on('timecard:approve', (data) => {
        console.log(data);
    });

    socket.on('timecard:reject', (data) => {
        console.log(data);
    });

    socket.on('timecard:review', (data) => {
        console.log(data);
    });
};