const db = require('../../models');
const { getActiveSessionUser } = require('../session');

const types = {
    attendance: { sizes: ['small', 'medium'], settings: ['departmentId', 'teamId', 'category', 'hideMetrics'] },
    hours: { sizes: ['medium', 'large'], settings: ['departmentId', 'teamId', 'week', 'hideMetrics'] },
    shipping: { sizes: ['medium', 'large'], settings: ['unit', 'periods', 'disabledDates', 'hideMetrics'] },
    inbound: { sizes: ['small', 'medium', 'large'], settings: ['range', 'status', 'hideMetrics'] },
    outbound: { sizes: ['small', 'medium', 'large'], settings: ['range', 'status', 'hideMetrics'] },
    agenda: { sizes: ['small', 'medium', 'large'], settings: ['range'] },
};
const choices = {
    category: ['all', 'present', 'absent', 'onBreak', 'activeEarly', 'activeOnTime', 'activeLate', 'activeDayOff', 'clockedOut', 'noShow', 'notStarted', 'dayOff'],
    week: ['current', 'previous'], unit: ['box', 'piece', 'pallet'], range: ['today', 'week'],
    status: ['', 'Pending', 'Scheduled', 'Ocean Transit', 'Discharged', 'En Route', 'In Transit', 'Receiving', 'Parked', 'Received', 'Completed', 'Cancelled', 'On Hold', 'Postponed'],
};
const outboundChoices = {
    range: ['today', 'threeDays', 'currentWeek', 'week'],
    status: ['', 'Pending', 'Carrier Accepted, Awaiting Pickup', 'Past Pickup', 'Picked Up', 'Completed', 'Cancelled'],
};

const validate = payload => {
    if (!payload || Object.keys(payload).some(key => !['version', 'widgets'].includes(key))
        || payload.version !== 1 || !Array.isArray(payload.widgets) || payload.widgets.length > 50)
        throw new Error('dashboard.invalid');
    const ids = new Set();
    for (const widget of payload.widgets) {
        const definition = widget && types[widget.type];
        if (!definition || Object.keys(widget).some(key => !['id', 'type', 'size', 'x', 'y', 'w', 'h', 'settings'].includes(key))
            || typeof widget.id !== 'string' || !/^[\w-]{1,80}$/.test(widget.id) || ids.has(widget.id)
            || !definition.sizes.includes(widget.size) || !Number.isInteger(widget.x) || typeof widget.y !== 'number' || !Number.isInteger(widget.y * 4)
            || (widget.w !== undefined && (!Number.isInteger(widget.w) || widget.w < 4 || widget.w > 12))
            || (widget.h !== undefined && (typeof widget.h !== 'number' || !Number.isInteger(widget.h * 4) || widget.h < 2 || widget.h > 20))
            || widget.x < 0 || widget.x + (widget.w ?? (widget.size === 'large' ? 8 : 4)) > 12 || widget.y < 0 || widget.y > 1000
            || !widget.settings || typeof widget.settings !== 'object' || Array.isArray(widget.settings))
            throw new Error('dashboard.invalid');
        ids.add(widget.id);
        for (const [key, value] of Object.entries(widget.settings)) {
            if (key !== 'autoExpand' && !definition.settings.includes(key)) throw new Error('dashboard.invalid');
            if (['hideMetrics', 'autoExpand'].includes(key) && typeof value !== 'boolean') throw new Error('dashboard.invalid');
            const allowed = widget.type === 'outbound' ? outboundChoices[key] ?? choices[key] : choices[key];
            if (allowed && !allowed.includes(value)) throw new Error('dashboard.invalid');
            if (key === 'periods' && (!Array.isArray(value) || value.length > 3 || new Set(value).size !== value.length
                || value.some(period => !['thisWeek', 'nextWeek', 'future'].includes(period))))
                throw new Error('dashboard.invalid');
            if (['departmentId', 'teamId'].includes(key) && (typeof value !== 'string' || !/^([a-f\d]{24})?$/i.test(value)))
                throw new Error('dashboard.invalid');
            if (key === 'disabledDates' && (!Array.isArray(value) || value.length > 32
                || value.some(date => typeof date !== 'string' || !/^(\d{2}\/\d{2}|Future)$/.test(date))))
                throw new Error('dashboard.invalid');
        }
    }
    return { version: 1, widgets: payload.widgets };
};

module.exports = socket => {
    socket.on('dashboard:get', async (_payload, callback) => {
        try {
            const user = await getActiveSessionUser(socket);
            const dashboard = await db.dashboard.findOne({ userId: user._id }).lean();
            callback({ status: 'success', payload: dashboard ? { version: dashboard.version, widgets: dashboard.widgets } : null });
        } catch (error) { callback({ status: 'error', message: error.message }); }
    });
    socket.on('dashboard:update', async (payload, callback) => {
        try {
            const user = await getActiveSessionUser(socket);
            const dashboard = validate(payload);
            await db.dashboard.updateOne({ userId: user._id }, { $set: dashboard }, { upsert: true, runValidators: true });
            callback({ status: 'success', payload: dashboard });
        } catch (error) { callback({ status: 'error', message: error.message }); }
    });
};
