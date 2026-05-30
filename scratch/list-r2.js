require('dotenv').config();
const { S3Client, ListObjectsV2Command, PutObjectCommand } = require('@aws-sdk/client-s3');

const client = new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
    }
});

async function testR2() {
    try {
        console.log('Putting object...');
        await client.send(new PutObjectCommand({
            Bucket: process.env.R2_BUCKET_NAME,
            Key: 'test-direct-put.txt',
            Body: Buffer.from('Hello R2'),
            ContentType: 'text/plain'
        }));
        console.log('Put object success!');

        console.log('Listing objects...');
        const data = await client.send(new ListObjectsV2Command({ Bucket: process.env.R2_BUCKET_NAME }));
        if (!data.Contents || data.Contents.length === 0) {
            console.log('Bucket is STILL empty?!');
        } else {
            console.log('Items in bucket:');
            data.Contents.forEach(item => console.log(`- ${item.Key} (${item.Size} bytes)`));
        }
    } catch(e) {
        console.error('Error:', e);
    }
}
testR2();
