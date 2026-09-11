const path = require('node:path');
const { readFile } = require('node:fs/promises');
const { createHash } = require('node:crypto');
const express = require('express');
const sharp = require('sharp');
const md5 = require('md5');
const db = require('../models');
const { io } = require('../socket/io');
const { notifyRegistrationsChanged } = require('../socket/userDelivery');
const { claimUsername, hashLoginPassword } = require('../utils/userAccount');

const router = express.Router();
const pageRoot = path.join(__dirname, '..', 'addon', 'registration');
const requests = new Map();
router.use((_req, res, next) => {
    res.removeHeader('Access-Control-Allow-Origin');
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'" });
    next();
});
router.get('/', async (_req, res) => {
    try {
        const now = new Date();
        const manufacturer = await db.config.findOne({
            key: 'manufacturer.name', scope: 'Global', status: 'Active',
            'effective.from': { $lte: now }, $or: [{ 'effective.to': null }, { 'effective.to': { $gte: now } }],
        }).sort({ 'effective.from': -1, version: -1 }).select('value').lean();
        const name = typeof manufacturer?.value === 'string' && manufacturer.value.trim() ? manufacturer.value.trim() : 'Account registration';
        const escapedName = name.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
        const page = await readFile(path.join(pageRoot, 'index.html'), 'utf8');
        res.type('html').send(page.replace('<!-- MANUFACTURER_NAME -->', () => escapedName));
    } catch {
        res.status(503).type('text').send('Registration is temporarily unavailable. Please try again.');
    }
});
router.use('/assets', express.static(path.join(pageRoot, 'assets')));
router.use('/api', (req, res, next) => {
    const now = Date.now();
    for (const [ip, entry] of requests) if (entry.until <= now) requests.delete(ip);
    const entry = requests.get(req.ip) || { count: 0, until: now + 15 * 60 * 1000 };
    if (entry.count >= 30 || (!requests.has(req.ip) && requests.size >= 10000)) return res.status(429).json({ message: 'Too many attempts. Please try again in 15 minutes.' });
    entry.count++;
    requests.set(req.ip, entry);
    next();
}, express.json({ limit: '8mb' }));

router.post('/api/:action', async (req, res) => {
    try {
        if (!['status', 'submit'].includes(req.params.action)) return res.sendStatus(404);
        const token = req.body?.token;
        if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{10}$/.test(token)) return res.status(410).json({ message: 'This registration link is invalid or expired. Ask your administrator for a new link.' });
        const tokenHash = createHash('sha256').update(token).digest('hex');
        const registration = await db.userRegistration.findOne({ tokenHash }).lean();
        if (!registration || (registration.status === 'Open' && registration.expiresAt <= new Date())) return res.status(410).json({ message: 'This registration link is invalid or expired. Ask your administrator for a new link.' });
        if (req.params.action === 'status') return res.json({ status: registration.status, expiresAt: registration.expiresAt });
        if (registration.status !== 'Open') return res.status(409).json({ message: 'This link has already been used. Your registration cannot be submitted again.' });
        const data = req.body;
        if (Object.keys(data).some(key => !['token', 'displayName', 'email', 'username', 'password', 'portrait'].includes(key))) return res.status(400).json({ message: 'Invalid registration fields.' });
        if (typeof data.displayName !== 'string' || !data.displayName.trim() || data.displayName.trim().length > 100) return res.status(400).json({ message: 'Enter your name (up to 100 characters).' });
        if (typeof data.email !== 'string' || data.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email.trim())) return res.status(400).json({ message: 'Enter a valid email address.' });
        if (typeof data.username !== 'string' || !/^[a-zA-Z0-9._@+\-]{3,64}$/.test(data.username)) return res.status(400).json({ message: 'Use 3–64 letters, numbers, dots, underscores, @, + or - for your username.' });
        if (typeof data.password !== 'string' || data.password.length < 8 || data.password.length > 128) return res.status(400).json({ message: 'Use a password between 8 and 128 characters.' });
        if (typeof data.portrait !== 'string' || data.portrait.length > 7 * 1024 * 1024 || !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(data.portrait)) return res.status(400).json({ message: 'Upload a JPG, PNG or WebP profile photo up to 5 MB.' });
        const bytes = Buffer.from(data.portrait.slice(data.portrait.indexOf(',') + 1), 'base64');
        if (bytes.length > 5 * 1024 * 1024) return res.status(400).json({ message: 'The profile photo must be 5 MB or smaller.' });
        let portrait;
        try {
            const photo = sharp(bytes, { limitInputPixels: 25000000 });
            const metadata = await photo.metadata();
            if (!['jpeg', 'png', 'webp'].includes(metadata.format) || (metadata.pages || 1) > 1) throw new Error('Invalid image');
            const resized = await photo.rotate().resize(512, 512, { fit: 'cover', withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
            portrait = `data:image/jpeg;base64,${resized.toString('base64')}`;
        } catch {
            return res.status(400).json({ message: 'This photo could not be read. Upload a valid JPG, PNG or WebP image.' });
        }
        try { await claimUsername(db.user, data.username); }
        catch { return res.status(409).json({ message: 'This username is unavailable. Choose another username.' }); }
        const password = await hashLoginPassword(md5(data.password + 'MANUFACTURING_EXECUTION_SYSTEM'));
        const submitted = await db.userRegistration.findOneAndUpdate({ _id: registration._id, status: 'Open', expiresAt: { $gt: new Date() } }, {
            $set: { status: 'Submitted', submittedAt: new Date(), displayName: data.displayName.trim(),
                email: data.email.trim().toLowerCase(), username: data.username, password, portrait },
        }, { new: true }).lean();
        if (!submitted) return res.status(409).json({ message: 'This link has expired or has already been used. Ask your administrator to check your registration.' });
        await notifyRegistrationsChanged(io);
        res.json({ status: 'Submitted' });
    } catch {
        res.status(503).json({ message: 'Registration is temporarily unavailable. Please try again.' });
    }
});
router.use((error, _req, res, _next) => res.status(error.type === 'entity.too.large' ? 413 : 400).json({ message: 'Unable to read the submission. Use a photo smaller than 5 MB and try again.' }));

module.exports = router;
