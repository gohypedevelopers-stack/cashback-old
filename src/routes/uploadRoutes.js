const express = require('express');
const router = express.Router();
const multer = require('multer');
const upload = require('../middleware/uploadMiddleware');
const { uploadFile, serveFile } = require('../controllers/uploadController');
const { protect } = require('../middleware/authMiddleware');

// Only logged in users can upload
router.post('/', protect, (req, res, next) => {
    upload.single('image')(req, res, (err) => {
        if (!err) return next();

        if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
            return res.status(413).json({
                message: `Image is too large. Maximum allowed size is ${upload.maxFileSizeMb || 10}MB.`
            });
        }

        return res.status(400).json({ message: err.message || 'Upload failed' });
    });
}, uploadFile);



// Only logged in users can view/download files
router.get('/:filename', protect, serveFile);

module.exports = router;
