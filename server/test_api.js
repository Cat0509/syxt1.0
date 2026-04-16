const http = require('http');

const token = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6InUxIiwidXNlcm5hbWUiOiJhZG1pbiIsInJvbGUiOiJtZXJjaGFudF9hZG1pbiIsIm1lcmNoYW50X2lkIjoibV9kZWZhdWx0Iiwic3RvcmVfaWQiOm51bGwsInN0YXR1cyI6ImFjdGl2ZSIsImlhdCI6MTc0MjcxMTIwNywiZXhwIjoxNzQyNzk3NjA3fQ.fU9M6Hro2tErY-o442O-oOcHfGQ6';

const options = {
    hostname: 'localhost',
    port: 3000,
    path: '/api/v1/orders',
    method: 'GET',
    headers: {
        'Authorization': `Bearer ${token}`
    }
};

const req = http.request(options, (res) => {
    let data = '';
    res.on('data', (chunk) => { data += chunk; });
    res.on('end', () => {
        console.log('Status Code:', res.statusCode);
        try {
            const json = JSON.parse(data);
            console.log('Order Count:', json.data ? json.data.length : 'N/A');
            if (json.data && json.data.length > 0) {
                console.log('First Order Items:', JSON.stringify(json.data[0].items, null, 2));
            } else {
                console.log('Full Response:', JSON.stringify(json, null, 2));
            }
        } catch (e) {
            console.log('Raw Data:', data);
        }
        process.exit();
    });
});

req.on('error', (e) => {
    console.error(`Problem with request: ${e.message}`);
    process.exit();
});

req.end();
