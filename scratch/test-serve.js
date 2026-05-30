const http = require('http');
const fs = require('fs');

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
        testServe(parsed.token);
      }
    } catch(e) {}
  });
});

req.write(JSON.stringify({
  email: 'admin@example.com',
  password: 'NewStrong@123'
}));
req.end();

function testServe(token) {
  const uploadOptions = {
    hostname: 'localhost',
    port: 5000,
    path: '/api/upload/image-1780056206572.png',
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`
    },
  };

  const uploadReq = http.request(uploadOptions, (res) => {
    let data = '';
    res.on('data', (chunk) => (data += chunk));
    res.on('end', () => {
      console.log('Serve Status:', res.statusCode);
      if (res.statusCode !== 200) {
        console.log('Serve Response:', data);
      } else {
        console.log('Serve Response Length:', data.length);
      }
    });
  });

  uploadReq.on('error', (e) => console.log('Connection Error:', e.message));
  uploadReq.end();
}
