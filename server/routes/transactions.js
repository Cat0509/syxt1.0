const express = require('express');
const router = express.Router();
const db = require('../db');
const { ApiResponse, asyncHandler } = require('../utils');
const { authenticate } = require('../middleware/auth');
const { requireRole, requireActiveUser, requireStoreScope } = require('../middleware/rbac');

// 获取所有交易 (需要鉴权)
router.get('/', authenticate, requireActiveUser, requireRole(['merchant_admin', 'store_manager', 'cashier']), requireStoreScope, asyncHandler(async (req, res) => {
    const { start_time, end_time, status } = req.query;
    const txs = await db.getTransactions(req.user.merchant_id, {
        storeId: req.effectiveStoreId,
        startTime: start_time ? parseInt(start_time) : null,
        endTime: end_time ? parseInt(end_time) : null,
        status: status || null
    });
    ApiResponse.success(res, txs);
}));

// 同步交易数据 (已禁用上行同步)
router.post('/sync', authenticate, requireActiveUser, requireRole(['merchant_admin', 'store_manager', 'cashier']), requireStoreScope, asyncHandler(async (req, res) => {
    return ApiResponse.error(res, 'Only read synchronization is allowed for transactions. Please use real-time /orders endpoint.', 400);
}));

module.exports = router;
