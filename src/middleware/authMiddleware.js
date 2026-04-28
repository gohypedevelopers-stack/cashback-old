const jwt = require('jsonwebtoken');
const prisma = require('../config/prismaClient');

const protect = async (req, res, next) => {
    let token;

    if (
        req.headers.authorization &&
        req.headers.authorization.startsWith('Bearer')
    ) {
        try {
            token = req.headers.authorization.split(' ')[1];

            const decoded = jwt.verify(token, process.env.JWT_SECRET);

            req.user = await prisma.user.findUnique({
                where: { id: decoded.id }
            });

            if (!req.user) {
                return res.status(401).json({ message: 'Not authorized, user not found' });
            }

            // SECURITY: Block inactive or blocked users from accessing protected routes
            if (req.user.status && req.user.status !== 'active') {
                return res.status(403).json({
                    message: `Your account is ${req.user.status}. Please contact support.`
                });
            }

            // Remove password from req.user
            delete req.user.password;

            next();
        } catch (error) {
            console.error(error);
            res.status(401).json({ message: 'Not authorized, token failed' });
        }
    } else {
        res.status(401).json({ message: 'Not authorized, no token' });
    }
};

const authorize = (...roles) => {
    return (req, res, next) => {
        if (!req.user || !roles.includes(req.user.role)) {
            return res.status(403).json({
                message: `User role ${req.user ? req.user.role : 'unknown'} is not authorized to access this route`
            });
        }
        next();
    };
};

// SECURITY: Block vendors whose vendor profile is not yet approved (pending/rejected/expired/paused)
const requireActiveVendor = async (req, res, next) => {
    try {
        const vendor = await prisma.vendor.findUnique({
            where: { userId: req.user.id },
            select: { id: true, status: true }
        });

        if (!vendor) {
            return res.status(403).json({
                message: 'Vendor profile not found. Please complete registration.'
            });
        }

        if (vendor.status !== 'active') {
            return res.status(403).json({
                message: `Your vendor account is ${vendor.status}. ${
                    vendor.status === 'pending'
                        ? 'Please wait for admin approval.'
                        : vendor.status === 'rejected'
                        ? 'Your application was rejected. Please contact support.'
                        : 'Please contact support.'
                }`
            });
        }

        // Attach vendor ID for downstream use
        req.vendorId = vendor.id;
        next();
    } catch (error) {
        console.error('[VENDOR STATUS CHECK ERROR]', error);
        res.status(500).json({ message: 'Server Error' });
    }
};

module.exports = { protect, authorize, requireActiveVendor };
