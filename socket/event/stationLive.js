const { getStationLive } = require('../../utils/stationLive');

module.exports = (socket, io) => {
    const live = getStationLive(io);
    for (const action of ['start', 'frame', 'action', 'stop', 'remoteMessage', 'transfer']) socket.on(`station:live:${action}`, async (input, callback) => {
        if (typeof callback !== 'function') return;
        try {
            if (!input || typeof input !== 'object') throw new Error('invalidAction');
            if (action === 'start' && !/^[a-f\d]{24}$/i.test(input._id || '')) throw new Error('invalidAction');
            const value = action === 'start' ? input._id : ['frame', 'stop'].includes(action) ? input.sessionId : input;
            callback({ status: 'success', payload: await live[action](socket, value, { frameProtocol: input.frameProtocol }) });
        } catch (error) { callback({ status: 'error', message: error.message }); }
    });
    socket.on('disconnect', () => live.stopForSocket(socket.id));
};
