const express = require('express');
const router = express.Router();
const db = require('../db');
const { ApiResponse, asyncHandler } = require('../utils');
const { authenticate } = require('../middleware/auth');

// 获取审计日志 (需要鉴权)
router.get('/', authenticate, asyncHandler(async (req, res) => {
    const { store_id, action, start_time, end_time, user_id, username, limit } = req.query;
    
    // 如果是店长，默认只能看自己门店
    const effectiveStoreId = req.user.role === 'merchant_admin' ? store_id : req.user.store_id;

    const filters = {
        storeId: effectiveStoreId,
        action,
        startTime: start_time ? parseInt(start_time) : null,
        endTime: end_time ? parseInt(end_time) : null,
        userId: user_id,
        username: username,
        limit: limit ? parseInt(limit) : 100
    };

    const logs = await db.getAuditLogs(req.user.merchant_id, filters);
    ApiResponse.success(res, logs);
}));

// 记录审计日志 (需要鉴权)
router.post('/', authenticate, asyncHandler(async (req, res) => {
    const { action, details, store_id } = req.body;
    if (!action || !details) {
        return ApiResponse.error(res, '缺少必要参数', 400, 400);
    }
    
    // 自动补充当前用户信息
    await db.saveAuditLog({ 
        action, 
        details, 
        store_id,
        user_id: req.user.id,
        username: req.user.name
    }, req.user.merchant_id);
    
    ApiResponse.success(res, null, '记录成功');
}));

module.exports = router;
