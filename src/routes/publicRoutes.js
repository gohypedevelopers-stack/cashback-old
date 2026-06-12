const express = require('express');
const router = express.Router();
const multer = require('multer');
const upload = require('../middleware/uploadMiddleware');
const {
    getHomeData,
    getCatalog,
    getProductDetails,
    getCategories,
    getActiveBrands,
    getBrandDetails,
    getFAQs,
    getStaticPage,
    getGiftCardCategories,
    getGiftCards,
    getGiftCardDetails,
    getStoreData,
    getPublicCoupons,
    getCouponDetails,
    getPublicBlogs,
    loginBlogTeam,
    saveBlogTeamPosts,
    uploadBlogTeamImage
} = require('../controllers/publicController');
const { verifyQR } = require('../controllers/redemptionController');
const { getSharedInvoice } = require('../controllers/vendorController');

// Universal / Public Routes (No Login Required)

router.get('/home', getHomeData);          // Home Screen
router.get('/products', getCatalog);       // Product Catalog / Gift Cards (filtered by category)
router.get('/products/:id', getProductDetails); // Product Info
router.get('/categories', getCategories);  // List Categories
router.get('/brands', getActiveBrands);    // Brand List
router.get('/brands/:id', getBrandDetails); // Brand Details
router.get('/qrs/:hash', verifyQR);        // Check QR Validity (Public)
router.get('/giftcards', getGiftCards);
router.get('/giftcards/categories', getGiftCardCategories);
router.get('/giftcards/:id', getGiftCardDetails);
router.get('/store', getStoreData);
router.get('/faqs', getFAQs);              // Common Questions
router.get('/content/:slug', getStaticPage); // Static Pages (terms, privacy)
router.get('/blogs', getPublicBlogs);
router.post('/blog/login', loginBlogTeam);
router.put('/blog/posts', saveBlogTeamPosts);
router.post('/blog/upload', (req, res, next) => {
    upload.single('image')(req, res, (err) => {
        if (!err) return next();

        if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
            return res.status(413).json({
                message: `Image is too large. Maximum allowed size is ${upload.maxFileSizeMb || 10}MB.`
            });
        }

        return res.status(400).json({ message: err.message || 'Upload failed' });
    });
}, uploadBlogTeamImage);

// New Coupon Routes
router.get('/coupons', getPublicCoupons);
router.get('/coupons/:id', getCouponDetails);
router.get('/invoices/shared/:token', getSharedInvoice);
router.get('/invoices/shared/:token/:filename', getSharedInvoice);

module.exports = router;
