const express = require('express');
const router = express.Router();
const db = require('../db');
const { ApiResponse } = require('../utils');
const { authenticate } = require('../middleware/auth');
const { requireRole, requireActiveUser } = require('../middleware/rbac');

// 获取所有门店列表 (需要鉴权)
// merchant_admin, store_manager, cashier 都能看，但 Day 5 会进一步做内容过滤
// 获取所有门店列表 (需要鉴权)
// merchant_admin 返回全部，store_manager 和 cashier 只返回自己所属门店
router.get('/', authenticate, requireActiveUser, requireRole(['merchant_admin', 'store_manager', 'cashier']), async (req, res) => {
    try {
        const stores = await db.getStoreList(req.user.merchant_id);

        if (req.user.role === 'merchant_admin') {
            return ApiResponse.success(res, stores);
        }

        // 非总部管理员，仅返回自己所属门店
        const myStore = stores.filter(s => s.id === req.user.store_id);
        ApiResponse.success(res, myStore);
    } catch (err) {
        ApiResponse.error(res, err.message);
    }
});

module.exports = router;
