const { getSharing } = require('../sharing');

module.exports = (socket, io) => {
    const sharing = getSharing(io);
    for (const [event, action] of Object.entries({ register: sharing.register, nearby: sharing.observe, signal: sharing.signal })) {
        socket.on(`sharing:${event}`, async (input, callback) => {
            try { callback?.({ status: 'success', payload: await action(socket, input) }); }
            catch (error) { callback?.({ status: 'error', message: error.message }); }
        });
    }
    socket.on('sharing:leave', () => sharing.remove(socket.id));
};
