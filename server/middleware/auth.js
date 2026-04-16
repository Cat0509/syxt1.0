const jwt = require('jsonwebtoken');
const { ApiResponse } = require('../utils');

// Middleware to verify JWT token
const authenticate = (req, res, next) => {
    const JWT_SECRET = (process.env.JWT_SECRET || '').trim();
    if (!JWT_SECRET) {
        console.error('FATAL ERROR: JWT_SECRET environment variable is not set.');
        return ApiResponse.error(res, 'Internal Server Error', 500);
    }
    // Check header or url parameters or post parameters for token
    const authHeader = req.headers['authorization'];
    console.log('DEBUG: Full authHeader:', authHeader);
    const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

    if (!token) {
        return ApiResponse.error(res, 'No token provided. Unauthorized access.', 401, 401);
    }

    // Verify token
    jwt.verify(token, JWT_SECRET, (err, decoded) => {
        if (err) {
            return ApiResponse.error(res, 'Failed to authenticate token.', 401, 401);
        }

        // Save decoded user info to request for use in other routes
        req.user = decoded;
        next();
    });
};

const generateToken = (user) => {
    const JWT_SECRET = (process.env.JWT_SECRET || '').trim();
    return jwt.sign(
        {
            id: user.id,
            username: user.username,
            role: user.role,
            merchant_id: user.merchant_id,
            store_id: user.store_id,
            status: user.status
        },
        JWT_SECRET,
        { expiresIn: '24h' }
    );
};

module.exports = {
    authenticate,
    generateToken
};
