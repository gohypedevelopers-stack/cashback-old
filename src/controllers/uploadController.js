const path = require('path');
const fs = require('fs');
const { uploadToR2 } = require('../utils/r2Storage');

exports.uploadFile = async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ message: 'No file uploaded' });
        }

        const r2Upload = await uploadToR2(req.file);

        if (!r2Upload || !r2Upload.url) {
             throw new Error('Failed to retrieve URL from R2 upload');
        }

        console.log('[Upload] Uploaded to R2:', r2Upload.url);
        res.status(201).json({
            message: 'File uploaded successfully',
            url: r2Upload.url
        });
    } catch (error) {
        console.error('[Upload] FAILED:', error.message);
        res.status(500).json({ message: 'Upload failed', error: error.message });
    }
};

exports.serveFile = (req, res) => {
    try {
        // Always serve the local file if it's requested and exists, 
        // even if R2 is active now, to support legacy image URLs.

        const { filename } = req.params;
        // Basic filename validation to prevent path traversal
        if (!filename || filename.includes('..')) {
            return res.status(400).json({ message: 'Invalid filename' });
        }

        const filePath = path.join(__dirname, '../../uploads', filename);

        if (fs.existsSync(filePath)) {
            res.sendFile(filePath);
        } else {
            res.status(404).json({ message: 'File not found' });
        }
    } catch (error) {
        res.status(500).json({ message: 'Failed to serve file', error: error.message });
    }
};
