const express = require('express');
const jwt = require('jsonwebtoken');
const { createHash } = require('node:crypto');
const db = require('../models');
const database = require('../config/database');
const dayjs = require('../utils/dayjs');
const { JWT_SECRET } = require('../socket/session');
const { getProductionOutput } = require('../utils/productionMetrics');
const actions = require('../utils/productionPalletActions')({ db, database, dayjs });
const router = express.Router();
const eligible = { isDeleted: { $ne: true }, hiringStatus: 'Active', 'employment.status': { $nin: ['Inactive', 'On Leave', 'Terminated'] } };
const validId = value => typeof value === 'string' && /^[a-f\d]{24}$/i.test(value);
const pinSignature = employee => createHash('sha256').update(String(employee.pin || '')).digest('hex');
const attempts = new Map();

router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
router.post('/login', async (req, res) => {
    const now = Date.now();
    for (const [ip, attempt] of attempts) if (attempt.until <= now && !attempt.pending) attempts.delete(ip);
    const key = req.ip;
    const attempt = attempts.get(key) || { failures: 0, pending: 0, until: now + 60000 };
    if (attempt.failures + attempt.pending >= 15) return res.status(429).json({ message: 'Too many attempts. Wait one minute and try again.' });
    attempts.set(key, attempt);
    attempt.pending++;
    const reject = (status, message) => { attempt.failures++; return res.status(status).json({ message }); };
    try {
        const { lineId, pin } = req.body || {};
        if (!JWT_SECRET) throw new Error('Mobile access is not configured.');
        if (!validId(lineId) || typeof pin !== 'string' || !/^\d{1,20}$/.test(pin)) return reject(400, 'Enter your employee PIN and open the link for your line.');
        const employee = await db.employee.findOne({ ...eligible, pin }).select('_id pin firstName lastName displayName').lean();
        const run = employee && await db.productionRun.findOne({ lineId, open: true, crew: { $elemMatch: { employeeId: employee._id, enabled: true } } }).select('_id').lean();
        // Recovery permits printing owned pallets; registration still checks the current crew in the shared action.
        const saved = employee && !run && await db.pallet.findOne({ lineId, registeredByEmployee: employee._id, voidedAt: null }).select('_id').lean();
        if (!run && !saved) return reject(403, 'Use the PIN of an employee assigned to this line or with a saved pallet to recover.');
        const token = jwt.sign({ lineId, employeeId: String(employee._id), pinSignature: pinSignature(employee) }, JWT_SECRET, { algorithm: 'HS256', audience: 'production-mobile', expiresIn: '8h' });
        res.json({ token, employeeId: String(employee._id), employeeName: employee.displayName || `${employee.firstName || ''} ${employee.lastName || ''}`.trim() });
    } catch { res.status(503).json({ message: 'Unable to sign in. Please try again.' }); }
    finally {
        attempt.pending--;
        if (!attempt.pending && !attempt.failures) attempts.delete(key);
    }
});

router.use(async (req, res, next) => {
    let session;
    try {
        const token = req.get('Authorization')?.match(/^Bearer (.+)$/)?.[1];
        session = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'], audience: 'production-mobile' });
        if (!validId(session.lineId) || !validId(session.employeeId)) throw new Error('Invalid session');
    } catch { return res.status(401).json({ message: 'Employee access expired or changed. Sign in again.' }); }
    try {
        const employee = await db.employee.findOne({ ...eligible, _id: session.employeeId }).select('_id pin firstName lastName displayName').lean();
        if (!employee || pinSignature(employee) !== session.pinSignature) return res.status(401).json({ message: 'Employee access expired or changed. Sign in again.' });
        req.productionEmployee = { employeeId: String(employee._id), lineId: session.lineId, displayName: employee.displayName || `${employee.firstName || ''} ${employee.lastName || ''}`.trim() };
        next();
    } catch { res.status(503).json({ message: 'Employee access is temporarily unavailable. Please try again.' }); }
});

router.get('/context', async (req, res) => {
    try {
        const actor = req.productionEmployee;
        const current = await db.productionRun.findOne({ lineId: actor.lineId, open: true }).lean();
        const run = current?.crew.some(slot => slot.enabled && String(slot.employeeId) === actor.employeeId) ? current : null;
        const { totals } = await getProductionOutput(db, run, new Date());
        res.json({ recoveryOnly: !run, run: run ? Object.fromEntries(['_id', 'lineId', 'lineName', 'productName', 'styleCode', 'lotNumber', 'status', 'packaging'].map(key => [key, run[key]])) : null, totals });
    } catch { res.status(503).json({ message: 'Unable to refresh production. Try again.' }); }
});

for (const [route, action] of [['register', 'register'], ['prepare-print', 'preparePrint'], ['print-result', 'printResult']]) {
    router.post(`/${route}`, async (req, res) => {
        try {
            const pallet = await actions[action](req.body || {}, req.productionEmployee);
            res.json({ pallet });
        } catch (error) {
            const message = error.code === 11000 ? 'productionPallet.errors.conflict' : error.message;
            const known = message.startsWith('productionPallet.errors.');
            res.status(known ? 409 : 503).json({ message: known ? message : 'Unable to save. Retry the same request.' });
        }
    });
}
module.exports = router;
