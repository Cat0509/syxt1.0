require('dotenv').config();
const secret = (process.env.JWT_SECRET || '').trim();
console.log(`DEBUG: JWT_SECRET from gen_token.js: '${secret}' (length: ${secret.length})`);
const { generateToken } = require('./middleware/auth');

const user = {
    id: 'u1',
    username: 'admin',
    role: 'merchant_admin',
    merchant_id: 'm_default',
    store_id: null,
    status: 'active'
};

const token = generateToken(user);
console.log(token);
