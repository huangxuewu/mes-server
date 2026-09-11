const { randomBytes, createHash } = require('node:crypto');
const db = require('../../models');
const { getActiveSessionUser, canAdministerAccounts } = require('../session');
const { notifyRegistrationsChanged } = require('../userDelivery');
const { claimUsername } = require('../../utils/userAccount');

module.exports = (socket, io) => {
    for (const event of ['userRegistration:invite', 'userRegistrations:get', 'userRegistration:approve', 'userRegistration:reject']) {
        socket.on(event, async (payload = {}, callback) => {
            const generation = socket.data.sessionGeneration;
            const reply = result => callback?.(generation === socket.data.sessionGeneration && socket.data.expiresAt > Date.now()
                ? result : { status: 'error', message: 'Session changed. Sign in again.' });
            try {
                const actor = await getActiveSessionUser(socket);
                if (!canAdministerAccounts(actor)) throw new Error('Account administration requires Admin access');
                if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Invalid registration request');
                if (event === 'userRegistration:invite') {
                    const token = randomBytes(8).toString('base64url').slice(0, 10);
                    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
                    const registration = await db.userRegistration.create({ token, tokenHash: createHash('sha256').update(token).digest('hex'), expiresAt, createdBy: actor._id });
                    await notifyRegistrationsChanged(io);
                    return reply({ status: 'success', payload: { _id: registration._id, status: registration.status, path: `/register#${token}`, expiresAt, createdAt: registration.createdAt } });
                }
                if (event === 'userRegistrations:get') {
                    const registrations = await db.userRegistration.find({ status: { $in: ['Open', 'Submitted'] } })
                        .select('_id status displayName email username portrait submittedAt createdAt expiresAt token').sort({ createdAt: -1 }).lean();
                    return reply({ status: 'success', payload: registrations.map(({ token, ...registration }) => ({ ...registration, path: token ? `/register#${token}` : '' })) });
                }
                if (typeof payload._id !== 'string' || !/^[a-f\d]{24}$/i.test(payload._id)) throw new Error('Invalid registration ID');
                if (event === 'userRegistration:reject') {
                    const result = await db.userRegistration.updateOne({ _id: payload._id, status: 'Submitted' }, {
                        $set: { status: 'Rejected', reviewedBy: actor._id, reviewedAt: new Date() },
                        $unset: { password: 1, portrait: 1, token: 1 },
                    });
                    if (!result.matchedCount) throw new Error('Registration already reviewed. Refresh and try again.');
                    await notifyRegistrationsChanged(io);
                    return reply({ status: 'success' });
                }
                if (Object.keys(payload).some(key => !['_id', 'role', 'permissionCategoryId'].includes(key))) throw new Error('Invalid provisioning fields');
                if (!['Admin', 'Manager', 'User'].includes(payload.role)) throw new Error('Invalid account role');
                const categoryId = payload.permissionCategoryId;
                if (typeof categoryId !== 'string' || (categoryId && !/^[a-f\d]{24}$/i.test(categoryId))) throw new Error('Invalid permission category');
                if (categoryId && !await db.permissionCategory.findById(categoryId).lean()) throw new Error('Permission category not found');
                const session = await db.user.db.startSession();
                let userId;
                try {
                    await session.withTransaction(async () => {
                        const registration = await db.userRegistration.findOne({ _id: payload._id, status: 'Submitted' }).select('+password').session(session).lean();
                        if (!registration) throw new Error('Registration already reviewed. Refresh and try again.');
                        const username = await claimUsername(db.user, registration.username, null, session);
                        const [user] = await db.user.create([{
                            ...username, displayName: registration.displayName, email: registration.email,
                            portrait: registration.portrait, password: registration.password,
                            role: payload.role, permissionCategoryId: categoryId, permission: {}, status: 'Active',
                        }], { session });
                        userId = user._id;
                        await db.userRegistration.updateOne({ _id: registration._id, status: 'Submitted' }, {
                            $set: { status: 'Approved', userId, reviewedBy: actor._id, reviewedAt: new Date() },
                            $unset: { password: 1, portrait: 1, token: 1 },
                        }, { session });
                    });
                } finally {
                    await session.endSession();
                }
                await notifyRegistrationsChanged(io);
                reply({ status: 'success', payload: { userId } });
            } catch (error) {
                reply({ status: 'error', message: error.code === 11000 ? 'Username is already in use' : error.message });
            }
        });
    }
};
