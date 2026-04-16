const { ApiResponse } = require('../utils');

/**
 * Middleware to require specific roles
 * @param {string[]} roles 
 */
const requireRole = (roles) => {
    return (req, res, next) => {
        if (!req.user || !roles.includes(req.user.role)) {
            return ApiResponse.error(res, 'Access denied. Insufficient permissions.', 403, 403);
        }
        next();
    };
};

/**
 * Middleware to ensure the user is active
 */
const requireActiveUser = (req, res, next) => {
    // We assume the token already contains the status from when it was generated.
    // In more advanced scenarios, we would re-check the DB or a cache.
    if (!req.user || req.user.status !== 'active') {
        return ApiResponse.error(res, 'User account is inactive or session is invalid.', 401, 401);
    }
    next();
};

/**
 * Middleware to resolve and enforce store scope
 * Sets req.effectiveStoreId based on user role and request parameters.
 */
const requireStoreScope = (req, res, next) => {
    const user = req.user;
    if (!user) return ApiResponse.error(res, 'Unauthorized', 401, 401);

    // 1. Get requested store_id from query, body, or params
    const requestedStoreId = req.query.store_id || req.body.store_id || req.params.store_id;

    if (user.role === 'merchant_admin') {
        // Admins can access any store within their merchant, or all stores if none specified
        req.effectiveStoreId = requestedStoreId || null;
    } else {
        // Managers and Cashiers are locked to their own store_id
        // Even if they try to request another store_id, we override it with their own
        req.effectiveStoreId = user.store_id;

        // Safety check: if they explicitly requested a DIFFERENT store_id, we might want to block or just silently override.
        // The plan says: "ensures the requested store_id matches their own, or forces their own store_id"
        // Let's be strict: if they requested something else, return 403.
        if (requestedStoreId && requestedStoreId !== user.store_id) {
            return ApiResponse.error(res, 'Access denied. You do not have permission to access this store.', 403, 403);
        }
    }

    next();
};

module.exports = {
    requireRole,
    requireActiveUser,
    requireStoreScope
};
