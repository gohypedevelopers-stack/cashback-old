const multer = require('multer');
const path = require('path');
const { isR2Configured } = require('../utils/r2Storage');

const DEFAULT_MAX_FILE_SIZE_MB = 10;
const parsedMaxSizeMb = Number(process.env.UPLOAD_MAX_FILE_SIZE_MB);
const MAX_FILE_SIZE_MB = Number.isFinite(parsedMaxSizeMb) && parsedMaxSizeMb > 0
    ? parsedMaxSizeMb
    : DEFAULT_MAX_FILE_SIZE_MB;

// File Filter (Images Only)
const fileFilter = (req, file, cb) => {
    const filetypes = /jpeg|jpg|png|webp/;
    const mimetype = filetypes.test(file.mimetype);
    const extname = file.originalname ? filetypes.test(path.extname(file.originalname).toLowerCase()) : true;

    if (mimetype && (extname || !path.extname(file.originalname))) {
        return cb(null, true);
    } else {
        cb(new Error(`Images Only! Received mimetype: ${file.mimetype}, filename: ${file.originalname}`));
    }
};

// Exclusively use memory storage for R2 uploads
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: Math.round(MAX_FILE_SIZE_MB * 1024 * 1024) },
    fileFilter: fileFilter
});

upload.maxFileSizeMb = MAX_FILE_SIZE_MB;

module.exports = upload;
