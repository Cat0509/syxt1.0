const express = require('express');
const router = express.Router();
const db = require('../db');
const { ApiResponse, asyncHandler } = require('../utils');
const { authenticate } = require('../middleware/auth');
const { requireRole, requireActiveUser, requireStoreScope } = require('../middleware/rbac');

// 获取所有商品 (需要认证)
router.get('/', authenticate, requireActiveUser, requireRole(['merchant_admin', 'store_manager', 'cashier']), requireStoreScope, asyncHandler(async (req, res) => {
    // 获取当前租户的商品，使用经过中间件验证后的有效 store_id
    const products = await db.getProducts(req.user.merchant_id, req.effectiveStoreId);
    ApiResponse.success(res, products);
}));

// 同步商品数据 (需要认证)
// 仅管理员和店长可管理商品
router.post('/sync', authenticate, requireActiveUser, requireRole(['merchant_admin', 'store_manager']), requireStoreScope, asyncHandler(async (req, res) => {
    const { products } = req.body;

    if (!Array.isArray(products)) {
        return ApiResponse.error(res, 'Invalid data format: products must be an array', 400, 400);
    }

    // 基础验证示例
    for (const p of products) {
        if (!p.id || !p.name) {
            return ApiResponse.error(res, `Invalid product data: missing id or name for ${JSON.stringify(p)}`, 400, 400);
        }
    }

    // 使用当前登录用户的 merchant_id 存入数据库
    // merchant_admin 必须指定 store_id（可在 body 顶层或每个 product 内）
    for (const p of products) {
        let targetStoreId = req.effectiveStoreId;
        if (req.user.role === 'merchant_admin') {
            targetStoreId = p.store_id || req.effectiveStoreId;
            if (!targetStoreId) {
                return ApiResponse.error(res, 'store_id is required for merchant admin product sync', 400, 400);
            }
        }
        await db.saveProduct({ ...p, store_id: targetStoreId }, req.user.merchant_id);
    }

    ApiResponse.success(res, { count: products.length }, 'Products synced successfully');
}));

// 删除商品 (需要认证)
router.delete('/:id', authenticate, requireActiveUser, requireRole(['merchant_admin', 'store_manager']), asyncHandler(async (req, res) => {
    const { id } = req.params;
    await db.deleteProduct(id, req.user.merchant_id);
    ApiResponse.success(res, { id }, 'Product deleted successfully');
}));

// 设置门店差异价格 (仅管理员和店长)
router.post('/store-price', authenticate, requireActiveUser, requireRole(['merchant_admin', 'store_manager']), requireStoreScope, asyncHandler(async (req, res) => {
    const { product_id, sku_id, price, store_id } = req.body;
    const targetStoreId = store_id || req.effectiveStoreId;

    if (!product_id || price === undefined) {
        return ApiResponse.error(res, 'product_id and price are required', 400);
    }

    if (!targetStoreId) {
        return ApiResponse.error(res, 'store_id is required', 400);
    }

    await db.saveStorePrice({
        store_id: targetStoreId,
        product_id,
        sku_id,
        price
    }, req.user.merchant_id);

    // Audit Log
    await db.saveAuditLog({
        action: 'STORE_PRICE_CHANGED',
        details: { product_id, sku_id, price, store_id: targetStoreId },
        store_id: targetStoreId,
        user_id: req.user.id,
        username: req.user.username
    }, req.user.merchant_id);

    ApiResponse.success(res, null, 'Store price updated successfully');
}));

module.exports = router;
