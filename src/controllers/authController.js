const prisma = require('../config/prismaClient');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { safeLogVendorActivity } = require('../utils/vendorActivityLogger');
const { safeLogActivity } = require('../utils/activityLogger');
const { sendOTPEmail, sendEmail } = require('../utils/emailService');

const generateToken = (id, role) => {
    return jwt.sign({ id, role }, process.env.JWT_SECRET, {
        expiresIn: '15m' // Short-lived access token
    });
};

const normalizeLoginIdentifier = (value) =>
    String(value || '')
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '');

const findUserByFlexibleUsername = async (loginUsername) => {
    if (!loginUsername) return null;

    // 1) Exact username lookup
    let user = await prisma.user.findUnique({ where: { username: loginUsername } });
    if (user) return user;

    // 2) Case-insensitive username lookup
    user = await prisma.user.findFirst({
        where: {
            username: {
                equals: loginUsername,
                mode: 'insensitive'
            }
        }
    });
    if (user) return user;

    // 3) Separator-insensitive fallback (treat '-' and '_' etc. as equivalent).
    // Only accept when there is exactly one match to avoid ambiguous logins.
    const normalizedUsername = normalizeLoginIdentifier(loginUsername);
    if (!normalizedUsername) return null;

    const matches = await prisma.$queryRaw`
        SELECT id
        FROM "User"
        WHERE username IS NOT NULL
          AND LOWER(REGEXP_REPLACE(username, '[^a-zA-Z0-9]', '', 'g')) = ${normalizedUsername}
        LIMIT 2
    `;

    if (!Array.isArray(matches) || matches.length !== 1 || !matches[0]?.id) {
        return null;
    }

    return prisma.user.findUnique({ where: { id: matches[0].id } });
};

exports.register = async (req, res) => {
    const { name, email, password, username } = req.body;
    // SECURITY: Never accept 'role' from the request body on a public endpoint.
    // Roles are assigned server-side only (vendor via /vendor/register, admin manually).

    if (!email || !password) {
        return res.status(400).json({ message: 'Email and password are required' });
    }

    try {
        const normalizedEmail = email.trim().toLowerCase();
        const trimmedUsername = username ? username.trim() : null;

        // 1. Check if email is already registered
        const userByEmail = await prisma.user.findUnique({ where: { email: normalizedEmail } });
        if (userByEmail && userByEmail.password) {
            return res.status(400).json({ message: 'User already exists' });
        }

        // SECURITY: Block registration if email belongs to a privileged role (admin/vendor)
        // Prevents hijacking partial admin/vendor accounts created via other flows
        if (userByEmail && ['admin', 'vendor'].includes(userByEmail.role)) {
            return res.status(403).json({ message: 'This email is associated with a restricted account. Please use the appropriate login method.' });
        }

        // 2. Check if username is already taken by someone else
        if (trimmedUsername) {
            const userByUsername = await prisma.user.findUnique({ where: { username: trimmedUsername } });
            if (userByUsername && userByUsername.email !== normalizedEmail) {
                return res.status(400).json({ message: 'Username already taken' });
            }
        }

        // Hash password
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        let user;
        if (userByEmail) {
            // Update existing partial user (likely created by OTP verification)
            user = await prisma.user.update({
                where: { id: userByEmail.id },
                data: {
                    name: name || userByEmail.name,
                    username: trimmedUsername || userByEmail.username,
                    password: hashedPassword,
                    role: userByEmail.role || 'customer'
                }
            });
        } else {
            // Create fresh user
            user = await prisma.user.create({
                data: {
                    name,
                    email: normalizedEmail,
                    username: trimmedUsername,
                    password: hashedPassword,
                    role: 'customer'
                }
            });
        }

        if (user) {
            res.status(201).json({
                _id: user.id,
                name: user.name,
                email: user.email,
                username: user.username,
                role: user.role,
                token: generateToken(user.id, user.role)
            });
        } else {
            res.status(400).json({ message: 'Invalid user data' });
        }
    } catch (error) {
        console.error('[REGISTER ERROR]', error);
        res.status(500).json({ message: 'Server Error', error: error.message });
    }
};

exports.checkUsername = async (req, res) => {
    const { username } = req.body;

    if (!username) {
        return res.status(400).json({ message: 'Username is required' });
    }

    try {
        const user = await prisma.user.findUnique({
            where: { username: username.trim() }
        });

        if (user) {
            return res.json({ available: false, message: 'Username is already taken' });
        }

        res.json({ available: true, message: 'Username is available' });
    } catch (error) {
        res.status(500).json({ message: 'Error checking username', error: error.message });
    }
};

exports.login = async (req, res) => {
    const { email, password, username, emailOrUsername } = req.body;

    const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
    const normalizedUsername = typeof username === 'string' ? username.trim() : '';
    const trimmedLogin = typeof emailOrUsername === 'string' ? emailOrUsername.trim() : '';

    const loginEmail = normalizedEmail || (trimmedLogin.includes('@') ? trimmedLogin.toLowerCase() : '');
    const loginUsername = normalizedUsername || (!trimmedLogin.includes('@') ? trimmedLogin : '');

    if (!loginEmail && !loginUsername) {
        return res.status(400).json({ message: 'Email or username is required' });
    }
    if (typeof password !== 'string' || !password.trim()) {
        return res.status(400).json({ message: 'Password is required' });
    }

    try {
        let user = null;
        if (loginEmail) {
            user = await prisma.user.findUnique({ where: { email: loginEmail } });
        }

        if (!user && loginUsername) {
            user = await findUserByFlexibleUsername(loginUsername);
        }

        // Allow vendor login using actual vendor id from onboarding response.
        if (!user && loginUsername) {
            const vendorAccount = await prisma.vendor.findUnique({
                where: { id: loginUsername },
                include: { User: true }
            });
            user = vendorAccount?.User || null;
        }

        if (!user) {
            return res.status(401).json({ message: 'Invalid credentials' });
        }

        const passwordMatched = user.password && (await bcrypt.compare(password, user.password));
        if (!passwordMatched) {
            return res.status(401).json({ message: 'Invalid credentials' });
        }

        // SECURITY: Block login for inactive or blocked users
        if (user.status && user.status !== 'active') {
            return res.status(403).json({
                message: `Your account is ${user.status}. Please contact support.`
            });
        }

        let vendorDetails;
        if (user.role === 'vendor') {
            const vendor = await prisma.vendor.findUnique({
                where: { userId: user.id },
                include: { Brand: true }
            });

            if (!vendor) {
                return res.status(403).json({ message: 'Vendor profile not found' });
            }

            vendorDetails = {
                vendorId: vendor.id,
                brand: vendor.Brand,
                status: vendor.status
            };

            safeLogVendorActivity({
                vendorId: vendor.id,
                action: 'vendor_login',
                entityType: 'vendor',
                entityId: vendor.id,
                metadata: { identifier: loginEmail || loginUsername },
                req
            });
        }

        res.json({
            _id: user.id,
            name: user.name,
            email: user.email,
            username: user.username,
            role: user.role,
            token: generateToken(user.id, user.role),
            vendor: vendorDetails
        });

        safeLogActivity({
            actorUserId: user.id,
            actorRole: user.role,
            vendorId: vendorDetails?.vendorId,
            brandId: vendorDetails?.brand?.id,
            action: 'login',
            entityType: 'user',
            entityId: user.id,
            metadata: {
                identifier: loginEmail || loginUsername
            },
            req
        });
    } catch (error) {
        console.error('[LOGIN ERROR]', error);
        res.status(500).json({ 
            message: 'Server Error', 
            details: error.message 
        });
    }
};

exports.getMe = async (req, res) => {
    try {
        const user = await prisma.user.findUnique({
            where: { id: req.user.id }
        });

        if (user) {
            const { passwordExpires, ...userWithoutSensitive } = user;
            if (user.role === 'vendor') {
                const vendor = await prisma.vendor.findUnique({ where: { userId: user.id } });
                if (vendor) {
                    safeLogVendorActivity({
                        vendorId: vendor.id,
                        action: 'vendor_session_check',
                        entityType: 'vendor',
                        entityId: vendor.id,
                        req
                    });
                }
            }
            res.json(userWithoutSensitive);
        } else {
            res.status(404).json({ message: 'User not found' });
        }
    } catch (error) {
        res.status(500).json({ message: 'Server Error' });
    }
};

// Always generate a real random OTP — no fixed test code
const generateOTP = () => Math.floor(100000 + Math.random() * 900000).toString();

exports.sendOtp = async (req, res) => {
    const { phoneNumber, name, email } = req.body;

    if (!phoneNumber) {
        return res.status(400).json({ message: 'Phone number is required' });
    }

    try {
        const otp = generateOTP();
        const otpExpires = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes

        let user = await prisma.user.findUnique({ where: { phoneNumber } });

        // SECURITY: OTP Rate Limiting
        const now = new Date();
        if (user && user.otpLastSent) {
            const timeSinceLastOtp = now.getTime() - new Date(user.otpLastSent).getTime();
            const COOLDOWN_MS = 60 * 1000;
            if (timeSinceLastOtp < COOLDOWN_MS) {
                const waitTime = Math.ceil((COOLDOWN_MS - timeSinceLastOtp) / 1000);
                return res.status(429).json({ 
                    message: `Please wait ${waitTime} seconds before requesting a new OTP.` 
                });
            }
        }

        if (!user) {
            // Create new partial user
            user = await prisma.user.create({
                data: {
                    phoneNumber,
                    name: name || null,
                    email: email || null,
                    role: 'customer',
                    otp,
                    otpExpires,
                    otpLastSent: new Date()
                }
            });
        } else {
            // Update existing user OTP and sync name/email if provided
            const updateData = {
                otp,
                otpExpires,
                otpLastSent: new Date()
            };
            if (name) updateData.name = name;
            if (email) updateData.email = email;

            user = await prisma.user.update({
                where: { phoneNumber },
                data: updateData
            });
        }

        // Send OTP via email if provided
        if (email) {
            try {
                await sendOTPEmail(email.trim().toLowerCase(), otp);
                console.log(`[EMAIL SMTP] OTP sent to ${email}`);
            } catch (mailError) {
                console.error('[MAIL ERROR] Failed to send OTP email:', mailError);
            }
        }

        // In a real app, send SMS here.
        console.log(`OTP for ${phoneNumber}: ${otp}`);

        res.json({
            success: true,
            message: 'OTP sent successfully'
        });

    } catch (error) {
        res.status(500).json({ message: 'Server Error', error: error.message });
    }
};

exports.verifyOtp = async (req, res) => {
    const { phoneNumber, otp } = req.body;

    if (!phoneNumber || !otp) {
        return res.status(400).json({ message: 'Phone number and OTP are required' });
    }

    try {
        const user = await prisma.user.findUnique({ where: { phoneNumber } });

        if (!user) {
            return res.status(400).json({ message: 'User not found' });
        }

        if (user.otp !== otp) {
            return res.status(400).json({ message: 'Invalid OTP' });
        }

        if (new Date() > user.otpExpires) {
            return res.status(400).json({ message: 'OTP Expired' });
        }

        // Clear OTP
        await prisma.user.update({
            where: { id: user.id },
            data: {
                otp: null,
                otpExpires: null
            }
        });

        res.json({
            _id: user.id,
            name: user.name,
            phoneNumber: user.phoneNumber,
            role: user.role,
            token: generateToken(user.id, user.role)
        });

    } catch (error) {
        res.status(500).json({ message: 'Server Error', error: error.message });
    }
};

exports.sendEmailOtp = async (req, res) => {
    const { email } = req.body || {};

    if (!email) {
        return res.status(400).json({ message: 'Email is required' });
    }

    const normalizedEmail = String(email).trim().toLowerCase();

    try {
        const user = await prisma.user.findUnique({ where: { email: normalizedEmail } });

        if (!user || user.role !== 'vendor') {
            return res.status(404).json({ message: 'User not found' });
        }

        // SECURITY: OTP Rate Limiting / Resend Cooldown
        const now = new Date();
        if (user.otpLastSent) {
            const timeSinceLastOtp = now.getTime() - new Date(user.otpLastSent).getTime();
            const COOLDOWN_MS = 60 * 1000; // 1 minute cooldown

            if (timeSinceLastOtp < COOLDOWN_MS) {
                const waitTime = Math.ceil((COOLDOWN_MS - timeSinceLastOtp) / 1000);
                return res.status(429).json({ 
                    message: `Please wait ${waitTime} seconds before requesting a new OTP.` 
                });
            }
        }

        const otp = generateOTP();
        const otpExpires = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

        await prisma.user.update({
            where: { id: user.id },
            data: {
                otp,
                otpExpires,
                otpLastSent: new Date()
            }
        });

        // Send Real Email via SMTP
        try {
            await sendOTPEmail(normalizedEmail, otp);
            console.log(`[EMAIL SMTP] OTP sent to ${normalizedEmail}`);
        } catch (mailError) {
            console.error('[MAIL ERROR] Failed to send OTP email:', mailError);
            // We still return success: true because the OTP is saved in DB and printed in console for dev
            // But in production, this would be a critical failure.
        }

        res.json({
            success: true,
            message: 'OTP sent successfully'
        });
    } catch (error) {
        console.error('[REGISTER ERROR]', error);
        res.status(500).json({ message: 'Server Error', error: error.message });
    }
};

exports.sendEmailVerificationOtp = async (req, res) => {
    const { email, name } = req.body;

    if (!email) {
        return res.status(400).json({ message: 'Email is required' });
    }

    try {
        const normalizedEmail = email.trim().toLowerCase();
        const otp = generateOTP();
        const otpExpires = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes

        let user = await prisma.user.findUnique({ where: { email: normalizedEmail } });

        if (!user) {
            user = await prisma.user.create({
                data: {
                    email: normalizedEmail,
                    name: name || null,
                    role: 'vendor',
                    otp,
                    otpExpires
                }
            });
        } else {
            user = await prisma.user.update({
                where: { id: user.id },
                data: {
                    otp,
                    otpExpires
                }
            });
        }

        try {
            await sendOTPEmail(normalizedEmail, otp, 'vendor');
            console.log(`[EMAIL SMTP] Verification OTP sent to ${normalizedEmail}`);
        } catch (mailError) {
            console.error('[MAIL ERROR] Failed to send Verification OTP email:', mailError);
        }

        res.json({
            success: true,
            message: 'OTP sent successfully to email'
        });

    } catch (error) {
        res.status(500).json({ message: 'Server Error', error: error.message });
    }
};

exports.verifyEmailVerificationOtp = async (req, res) => {
    const { email, otp } = req.body;

    if (!email || !otp) {
        return res.status(400).json({ message: 'Email and OTP are required' });
    }

    try {
        const normalizedEmail = email.trim().toLowerCase();
        const user = await prisma.user.findUnique({ where: { email: normalizedEmail } });

        if (!user) {
            return res.status(400).json({ message: 'User not found' });
        }

        if (user.otp !== otp) {
            return res.status(400).json({ message: 'Invalid OTP' });
        }

        if (user.otpExpires && new Date() > user.otpExpires) {
            return res.status(400).json({ message: 'OTP Expired' });
        }

        // Clear OTP
        await prisma.user.update({
            where: { id: user.id },
            data: {
                otp: null,
                otpExpires: null
            }
        });

        res.json({
            success: true,
            message: 'Email verified successfully'
        });

    } catch (error) {
        res.status(500).json({ message: 'Server Error', error: error.message });
    }
};

exports.resetPasswordWithOtp = async (req, res) => {
    const { email, otp, password } = req.body || {};

    if (!email || !otp || !password) {
        return res.status(400).json({ message: 'Email, OTP and new password are required' });
    }

    if (String(password).length < 6) {
        return res.status(400).json({ message: 'Password must be at least 6 characters' });
    }

    try {
        const normalizedEmail = String(email).trim().toLowerCase();
        const user = await prisma.user.findUnique({ where: { email: normalizedEmail } });

        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        if (!user.otp || user.otp !== String(otp)) {
            return res.status(400).json({ message: 'Invalid OTP' });
        }

        if (!user.otpExpires || new Date() > user.otpExpires) {
            return res.status(400).json({ message: 'OTP expired' });
        }

        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        await prisma.user.update({
            where: { id: user.id },
            data: {
                password: hashedPassword,
                otp: null,
                otpExpires: null,
                resetPasswordToken: null,
                resetPasswordExpires: null
            }
        });

        res.json({ success: true, message: 'Password updated successfully' });
    } catch (error) {
        res.status(500).json({ message: 'Error resetting password', error: error.message });
    }
};

exports.forgotPassword = async (req, res) => {
    const { email } = req.body;

    try {
        const user = await prisma.user.findUnique({ where: { email } });

        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        // Generate Token
        const resetToken = crypto.randomBytes(20).toString('hex');

        // Hash it to store in DB
        const resetPasswordToken = crypto
            .createHash('sha256')
            .update(resetToken)
            .digest('hex');

        // Set Expiry (10 mins)
        const resetPasswordExpires = new Date(Date.now() + 10 * 60 * 1000);

        await prisma.user.update({
            where: { id: user.id },
            data: {
                resetPasswordToken,
                resetPasswordExpires
            }
        });

        // Send Real Email via SMTP
        const resetUrl = `http://localhost:3000/reset-password/${resetToken}`;
        try {
            await sendEmail({
                to: email,
                subject: 'Password Reset Request',
                text: `You requested a password reset. Please use the following link to reset your password: ${resetUrl}`,
                html: `
                    <div style="font-family: Arial, sans-serif; padding: 20px; color: #333;">
                        <h2 style="color: #4A90E2;">Password Reset</h2>
                        <p>You requested a password reset for your Cashback App account.</p>
                        <p>Please click the button below to reset your password:</p>
                        <div style="margin: 30px 0;">
                            <a href="${resetUrl}" style="background: #4A90E2; color: white; padding: 12px 25px; text-decoration: none; border-radius: 5px; font-weight: bold;">Reset Password</a>
                        </div>
                        <p>If you didn't request this, please ignore this email.</p>
                        <p>This link will expire in 10 minutes.</p>
                        <hr style="border: none; border-top: 1px solid #eee; margin-top: 30px;">
                        <p style="font-size: 12px; color: #888;">Cashback App Team</p>
                    </div>
                `
            });
            console.log(`[EMAIL SMTP] Password Reset Link sent to ${email}`);
        } catch (mailError) {
            console.error('[MAIL ERROR] Failed to send reset email:', mailError);
        }

        res.json({ success: true, message: 'Email sent' });

    } catch (error) {
        res.status(500).json({ message: 'Error sending email', error: error.message });
    }
};

exports.resetPassword = async (req, res) => {
    const { token, password } = req.body;

    try {
        // Hash token to compare
        const resetPasswordToken = crypto
            .createHash('sha256')
            .update(token)
            .digest('hex');

        const user = await prisma.user.findFirst({
            where: {
                resetPasswordToken,
                resetPasswordExpires: { gt: new Date() }
            }
        });

        if (!user) {
            return res.status(400).json({ message: 'Invalid or expired token' });
        }

        // Set new password
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        await prisma.user.update({
            where: { id: user.id },
            data: {
                password: hashedPassword,
                resetPasswordToken: null,
                resetPasswordExpires: null
            }
        });

        res.json({ success: true, message: 'Password updated successfully' });

    } catch (error) {
        res.status(500).json({ message: 'Error resetting password', error: error.message });
    }
};

exports.setPassword = async (req, res) => {
    const { password } = req.body;

    if (!password || password.length < 6) {
        return res.status(400).json({ message: 'Password must be at least 6 characters' });
    }

    try {
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        await prisma.user.update({
            where: { id: req.user.id },
            data: { password: hashedPassword }
        });

        res.json({ success: true, message: 'Password set successfully' });
    } catch (error) {
        res.status(500).json({ message: 'Error setting password', error: error.message });
    }
};

// Vendor Self-Registration
exports.registerVendor = async (req, res) => {
    const { ownerName, brandName, category, mobile, email, password, city, state, website } = req.body;

    // Validation
    if (!ownerName || !brandName || !email || !password) {
        return res.status(400).json({
            message: 'Owner name, brand name, email, and password are required'
        });
    }

    if (password.length < 6) {
        return res.status(400).json({ message: 'Password must be at least 6 characters' });
    }

    try {
        // Check if email already exists
        const existingUser = await prisma.user.findUnique({ where: { email } });
        if (existingUser) {
            return res.status(400).json({ message: 'Email already registered' });
        }

        // Check if phone already exists (if provided)
        if (mobile) {
            const existingPhone = await prisma.user.findUnique({ where: { phoneNumber: mobile } });
            if (existingPhone) {
                return res.status(400).json({ message: 'Phone number already registered' });
            }
        }

        // Hash password
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        // Create User, Vendor, Wallet, and Brand in a transaction
        const result = await prisma.$transaction(async (tx) => {
            // 1. Create User with vendor role (status: active, but vendor/brand are pending)
            const user = await tx.user.create({
                data: {
                    name: ownerName,
                    email,
                    phoneNumber: mobile || null,
                    password: hashedPassword,
                    role: 'vendor',
                    status: 'inactive'
                }
            });

            // 2. Create Vendor Profile (status: pending - needs admin approval)
            const vendor = await tx.vendor.create({
                data: {
                    userId: user.id,
                    businessName: brandName,
                    contactPhone: mobile || null,
                    contactEmail: email,
                    address: city && state ? `${city}, ${state}` : city || state || null,
                    status: 'pending'
                }
            });

            // 3. Create Wallet with 0 balance
            const wallet = await tx.wallet.create({
                data: {
                    vendorId: vendor.id,
                    balance: 0.00,
                    currency: 'INR'
                }
            });

            // 4. Create Brand (status: pending - needs admin approval)
            const brand = await tx.brand.create({
                data: {
                    name: brandName,
                    vendorId: vendor.id,
                    website: website || null,
                    status: 'pending'
                }
            });

            // 5. Notify Admins about new vendor registration
            const admins = await tx.user.findMany({
                where: { role: 'admin' },
                select: { id: true }
            });

            if (admins.length) {
                const notifications = admins.map(admin => ({
                    userId: admin.id,
                    title: 'New Vendor Registration',
                    message: `${ownerName} has registered as a vendor with brand "${brandName}". Please review and activate.`,
                    type: 'vendor_registration',
                    metadata: {
                        vendorId: vendor.id,
                        brandId: brand.id,
                        ownerName,
                        brandName,
                        email,
                        mobile
                    }
                }));
                await tx.notification.createMany({ data: notifications });
            }

            return { user, vendor, wallet, brand };
        });

        safeLogActivity({
            actorUserId: result.user.id,
            actorRole: 'vendor',
            vendorId: result.vendor.id,
            brandId: result.brand.id,
            action: 'vendor_self_register',
            entityType: 'vendor',
            entityId: result.vendor.id,
            metadata: {
                ownerName,
                brandName,
                email,
                city,
                state
            },
            req
        });

        res.status(201).json({
            success: true,
            message: 'Registration successful! Your account is inactive and pending admin approval. You will be able to log in once your brand is verified.',
            _id: result.user.id,
            name: result.user.name,
            email: result.user.email,
            role: result.user.role,
            vendor: {
                vendorId: result.vendor.id,
                brand: result.brand,
                status: result.vendor.status
            }
        });

    } catch (error) {
        console.error('Vendor Registration Error:', error);
        res.status(500).json({ message: 'Registration failed', error: error.message });
    }
};
