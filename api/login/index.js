const md5 = require('md5');
const express = require('express');
const jwt = require('jsonwebtoken');
const User = require("../../models/user");
const router = express.Router();
const { verifyLoginPassword } = require('../../utils/userAccount');

// JWT secret key (in production, this should be in environment variables)
const JWT_SECRET = process.env.JWT_SECRET || 'DOWN_HOME_MES_SYSTEM';

// Password hashing salt (must match frontend)
const PASSWORD_SALT = 'MANUFACTURING_EXECUTION_SYSTEM';

// POST /api/login - User login
router.post('/', async (req, res) => {
    try {
        const { username, password } = req.body;

        // Validate input
        if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
            return res.status(400).json({
                success: false,
                message: 'Username and password are required'
            });
        }

        // Find user by username
        const user = await User.findOne({
            username: username,
            status: { $ne: 'Deleted' }
        });

        if (!user) {
            return res.status(401).json({
                success: false,
                message: 'Invalid username or password'
            });
        }

        // Check if user is active
        if (user.status !== 'Active') {
            return res.status(401).json({
                success: false,
                message: 'Account is not active. Please contact administrator.'
            });
        }

        // Verify password (assuming passwords are stored as MD5 hashes with salt)
        const hashedPassword = md5(password + PASSWORD_SALT);
        if (!await verifyLoginPassword(user.password, hashedPassword)) {
            return res.status(401).json({
                success: false,
                message: 'Invalid username or password'
            });
        }

        // Generate JWT token
        const token = jwt.sign(
            {
                userId: user._id,
                username: user.username,
                email: user.email,
                role: user.role
            },
            JWT_SECRET,
            { expiresIn: '24h' }
        );

        // Store user info in session
        req.session.user = {
            id: user._id,
            username: user.username,
            email: user.email,
            role: user.role,
            status: user.status
        };

        // Return JSON response
        res.json({
            success: true,
            message: 'Login successful',
            token: token,
            user: {
                id: user._id,
                username: user.username,
                email: user.email,
                role: user.role,
                status: user.status
            }
        });

    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error'
        });
    }
});

// GET /api/login - Render login page
router.get('/', (req, res) => {
    res.render('login', {
        title: 'Login - MES System',
        error: req.query.error || null
    });
});

// Registration requires an administrator-issued invitation and MES provisioning.
router.post('/register', (_req, res) => res.status(410).json({
    success: false,
    message: 'Ask your MES administrator for a registration link. Accounts must be provisioned in MES.',
}));

// Middleware to verify JWT token
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

    if (!token) {
        return res.status(401).json({
            success: false,
            message: 'Access token required'
        });
    }

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) {
            return res.status(403).json({
                success: false,
                message: 'Invalid or expired token'
            });
        }
        req.user = user;
        next();
    });
};

// GET /api/login/verify - Verify token
router.get('/verify', authenticateToken, (req, res) => {
    res.json({
        success: true,
        message: 'Token is valid',
        user: req.user
    });
});

// GET /api/login/logout - Logout user
router.get('/logout', (req, res) => {
    // Clear session
    req.session.destroy((err) => {
        if (err) {
            console.error('Error destroying session:', err);
        }
        // Redirect to home page
        res.redirect('/');
    });
});

module.exports = router;
