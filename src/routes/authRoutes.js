const express = require('express');
const router = express.Router();
const {
    register,
    login,
    getMe,
    sendOtp,
    verifyOtp,
    sendEmailOtp,
    resetPasswordWithOtp,
    forgotPassword,
    resetPassword,
    setPassword,
    registerVendor,
    checkUsername,
    sendEmailVerificationOtp,
    verifyEmailVerificationOtp,
    googleLogin
} = require('../controllers/authController');
const { protect } = require('../middleware/authMiddleware');

router.post('/register', register);
router.post('/check-username', checkUsername);
router.post('/login', login);
router.post('/google-login', googleLogin);
router.get('/me', protect, getMe);

router.post('/send-otp', sendOtp);
router.post('/verify-otp', verifyOtp);
router.post('/send-email-otp', sendEmailOtp);
router.post('/send-email-verification-otp', sendEmailVerificationOtp);
router.post('/verify-email-verification-otp', verifyEmailVerificationOtp);
router.post('/reset-password-otp', resetPasswordWithOtp);

router.post('/forgot-password', forgotPassword);
router.post('/reset-password', resetPassword);
router.post('/set-password', protect, setPassword); // Set password for logged-in users

// Vendor Self-Registration
router.post('/vendor/register', registerVendor);

module.exports = router;
