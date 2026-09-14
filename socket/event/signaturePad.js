const db = require('../../models');
const { getActiveSessionUser } = require('../session');
const { createSignaturePadPairing } = require('../../utils/signaturePadPairing');
const pairing = createSignaturePadPairing({ model: db.signaturePadPairing });

module.exports = socket => {
    let busy = false;
    for (const operation of ['reserve', 'confirm', 'cancel']) socket.on(`signaturePad:${operation}`, async (input, callback) => {
        if (typeof callback !== 'function') return;
        if (busy) return callback({ status: 'error', message: 'signaturePad.busy' });
        busy = true;
        try {
            const generation = socket.data.sessionGeneration;
            const user = await getActiveSessionUser(socket);
            if (user.role === 'System') throw new Error('signaturePad.signIn');
            const owner = `${socket.id}:${generation}:${user._id}`;
            let payload;
            if (operation === 'reserve') payload = await pairing.reserve(owner, input?.deviceId);
            else if (operation === 'confirm') payload = await pairing.confirm(owner, input?.reservationId, input?.code);
            else await pairing.cancel(owner, input?.reservationId);
            if (!socket.connected || socket.data.sessionGeneration !== generation || socket.data.expiresAt <= Date.now()) throw new Error('signaturePad.signIn');
            callback({ status: 'success', payload });
        } catch (error) { callback({ status: 'error', message: error.message }); }
        finally { busy = false; }
    });
};
