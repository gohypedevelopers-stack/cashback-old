const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware'); // Any authenticated user
const { addPayoutMethod, getPayoutMethods, requestWithdrawal, getWithdrawalHistory, getRazorpayConfig, createOrder, verifyPayment } = require('../controllers/paymentController');

router.use(protect);

// Payout Methods (UPI)
router.post('/methods', addPayoutMethod);
router.get('/methods', getPayoutMethods);

// Withdrawals
router.post('/withdraw', requestWithdrawal);
router.get('/withdrawals', getWithdrawalHistory);

// Razorpay (Recharge)
router.get('/config', getRazorpayConfig);
router.post('/order', createOrder);
router.post('/verify', verifyPayment);

module.exports = router;

