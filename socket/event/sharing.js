const { getSharing } = require('../sharing');

module.exports = (socket, io) => {
    const sharing = getSharing(io);
    for (const [event, action] of Object.entries({ create: sharing.phone.create, cancel: sharing.phone.cancel, progress: sharing.phone.progress })) {
        socket.on(`sharing:phone:${event}`, async (input, callback) => {
            try { const payload = await action(socket, input); if (typeof callback === 'function') callback({ status: 'success', payload }); }
            catch (error) { if (typeof callback === 'function') callback({ status: 'error', message: error.message }); }
        });
    }
    for (const [event, action] of Object.entries({ register: sharing.register, nearby: sharing.observe, signal: sharing.signal })) {
        socket.on(`sharing:${event}`, async (input, callback) => {
            try { const payload = await action(socket, input); if (typeof callback === 'function') callback({ status: 'success', payload }); }
            catch (error) { if (typeof callback === 'function') callback({ status: 'error', message: error.message }); }
        });
    }
    socket.on('sharing:leave', () => sharing.remove(socket.id));
};
