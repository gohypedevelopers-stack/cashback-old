const http = require('http');

const options = {
  hostname: 'localhost',
  port: 5000,
  path: '/api/auth/login',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
  },
};

const req = http.request(options, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    try {
      const parsed = JSON.parse(data);
      if (parsed.token) {
        testUpload(parsed.token);
      }
    } catch(e) {}
  });
});

req.write(JSON.stringify({
  email: 'admin@example.com',
  password: 'NewStrong@123'
}));
req.end();

function testUpload(token) {
  const boundary = '----TestBoundary123';
  const imgBuffer = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64'
  );

  const bodyParts = [
    `--${boundary}\r\n`,
    `Content-Disposition: form-data; name="image"; filename="test-r2-final.png"\r\n`,
    `Content-Type: image/png\r\n\r\n`,
  ];
  const bodyStart = Buffer.from(bodyParts.join(''));
  const bodyEnd = Buffer.from(`\r\n--${boundary}--\r\n`);
  const fullBody = Buffer.concat([bodyStart, imgBuffer, bodyEnd]);

  const uploadOptions = {
    hostname: 'localhost',
    port: 5000,
    path: '/api/upload',
    method: 'POST',
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': fullBody.length,
      'Authorization': `Bearer ${token}`
    },
  };

  const uploadReq = http.request(uploadOptions, (res) => {
    let data = '';
    res.on('data', (chunk) => (data += chunk));
    res.on('end', () => {
      console.log('Upload Status:', res.statusCode);
      console.log('Upload Response:', data);
    });
  });

  uploadReq.on('error', (e) => console.log('Connection Error:', e.message));
  uploadReq.write(fullBody);
  uploadReq.end();
}
