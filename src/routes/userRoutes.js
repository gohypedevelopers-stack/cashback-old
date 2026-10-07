const express = require('express');
const router = express.Router();
const {
    getDashboard, getRedemptionHistory, getTransactionHistory, updateUserProfile,
    getAvailableOffers, createSupportTicket, getSupportTickets,
    getNotifications, markNotificationRead,
    uploadAvatar, changePassword, deleteAccount, getHomeStats, redeemStoreProduct
} = require('../controllers/userController');
const {
    requestWithdrawal,
    addPayoutMethod, getPayoutMethods, deletePayoutMethod, getWithdrawalHistory
} = require('../controllers/paymentController');
const { scanAndRedeem } = require('../controllers/redemptionController');
const { protect } = require('../middleware/authMiddleware');
const upload = require('../middleware/uploadMiddleware');

router.get('/dashboard', protect, getDashboard);
router.get('/home-stats', protect, getHomeStats);
router.post('/scan-qr/:hash', protect, scanAndRedeem);

// Wallet & Payouts
router.post('/payout', protect, requestWithdrawal);
router.get('/payout-methods', protect, getPayoutMethods);
router.post('/payout-methods', protect, addPayoutMethod);
router.delete('/payout-methods/:id', protect, deletePayoutMethod);
router.get('/withdrawals', protect, getWithdrawalHistory);
router.post('/withdrawals', protect, require('../controllers/walletController').requestPayout);

router.get('/redemptions', protect, getRedemptionHistory);
router.get('/transactions', protect, getTransactionHistory);

// Profile Management
router.put('/profile', protect, updateUserProfile);
router.post('/avatar', protect, upload.single('image'), uploadAvatar);
router.put('/change-password', protect, changePassword);
router.delete('/account', protect, deleteAccount);

// New Features
router.get('/offers', protect, getAvailableOffers); // Searchable
router.post('/support', protect, createSupportTicket);
router.get('/support', protect, getSupportTickets); // History

router.get('/notifications', protect, getNotifications);
router.put('/notifications/:id/read', protect, markNotificationRead);
router.post('/store/redeem', protect, redeemStoreProduct);

// Explorer - Use /api/public/...
// router.get('/home', protect, getHomeData); 
// router.get('/products', protect, getCatalog);
// router.get('/products/:id', protect, getProductDetails);

module.exports = router;
