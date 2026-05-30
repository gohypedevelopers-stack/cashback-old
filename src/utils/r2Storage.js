const path = require('path');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const R2_ENV_KEYS = [
    'R2_ACCOUNT_ID',
    'R2_ACCESS_KEY_ID',
    'R2_SECRET_ACCESS_KEY',
    'R2_BUCKET_NAME',
    'R2_PUBLIC_URL'
];

const isR2Configured = () => {
    const missingKeys = R2_ENV_KEYS.filter((key) => !String(process.env[key] || '').trim());
    if (missingKeys.length > 0) {
        console.log(`[R2 Storage] Not configured. Missing keys: ${missingKeys.join(', ')}`);
        return false;
    }
    return true;
};

const getR2Client = () => {
    if (!isR2Configured()) return null;

    return new S3Client({
        region: 'auto',
        endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
        credentials: {
            accessKeyId: process.env.R2_ACCESS_KEY_ID,
            secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
        }
    });
};

const buildPublicUrl = (key) => {
    const baseUrl = String(process.env.R2_PUBLIC_URL || '').replace(/\/+$/, '');
    return `${baseUrl}/${key}`;
};

const buildObjectKey = (file) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const safeExt = ext && ext.length <= 10 ? ext : '';
    const folder = String(process.env.R2_UPLOAD_PREFIX || 'uploads').replace(/^\/+|\/+$/g, '');
    return `${folder}/image-${Date.now()}-${Math.round(Math.random() * 1e9)}${safeExt}`;
};

const uploadToR2 = async (file) => {
    if (!isR2Configured()) {
        throw new Error('Cloudflare R2 is not configured in the environment variables.');
    }
    
    if (!file?.buffer) {
        throw new Error('R2 uploads require multer memory storage.');
    }

    const client = getR2Client();
    const key = buildObjectKey(file);

    await client.send(new PutObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME,
        Key: key,
        Body: file.buffer,
        ContentType: file.mimetype,
        CacheControl: 'public, max-age=31536000, immutable'
    }));

    return {
        key,
        url: buildPublicUrl(key)
    };
};

module.exports = {
    isR2Configured,
    uploadToR2
};
