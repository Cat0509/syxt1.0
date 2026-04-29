const express = require('express');
const router = express.Router();
const db = require('../db');
const syncService = require('../sync_service');
const { ApiResponse, asyncHandler } = require('../utils');
const { authenticate } = require('../middleware/auth');
const { requireRole, requireActiveUser } = require('../middleware/rbac');

// GET /inventory - 获取当前库存列表
router.get('/', authenticate, requireActiveUser, requireRole(['merchant_admin', 'store_manager', 'cashier']), asyncHandler(async (req, res) => {
    const { store_id, product_id } = req.query;
    const merchant_id = req.user.merchant_id;
    
    // RBAC: store_manager and cashier can only see their own store's inventory
    let targetStoreId = store_id;
    if (req.user.role !== 'merchant_admin') {
        targetStoreId = req.user.store_id;
    }

    if (!targetStoreId) {
        return ApiResponse.error(res, 'store_id is required', 400);
    }

    const [rows] = await db.query(
        'SELECT * FROM inventory WHERE merchant_id = ? AND store_id = ?' + (product_id ? ' AND product_id = ?' : ''),
        product_id ? [merchant_id, targetStoreId, product_id] : [merchant_id, targetStoreId]
    );
    
    ApiResponse.success(res, rows);
}));

// 权限要求：仅限 merchant_admin 或 store_manager
router.post('/adjust', authenticate, requireActiveUser, requireRole(['merchant_admin', 'store_manager']), asyncHandler(async (req, res) => {
    const { store_id, product_id, sku_id, type, qty, reason } = req.body;
    const merchant_id = req.user.merchant_id;
    
    let target_store_id = store_id;
    
    // 权限校验与拦截
    if (req.user.role === 'store_manager') {
         if (store_id && store_id !== req.user.store_id) {
               return ApiResponse.error(res, 'Store managers can only adjust inventory for their own store', 403);
         }
         target_store_id = req.user.store_id; // 强制使用店长所属店铺
    } else if (req.user.role === 'merchant_admin') {
         if (!target_store_id) {
               return ApiResponse.error(res, 'store_id is required for merchant admin', 400);
         }
    }

    if (!qty || isNaN(qty) || qty === 0) {
        return ApiResponse.error(res, 'Valid adjustment quantity is required (can be positive or negative)', 400);
    }
    
    if (!product_id && !sku_id) {
        return ApiResponse.error(res, 'Either product_id or sku_id must be provided', 400);
    }

    const conn = await db.getConnection();
    try {
        await conn.beginTransaction();

        let adjustedName = '';
        let finalProductId = product_id;

        if (sku_id) {
            // 验证 SKU 是否存在于该商户（不再校验 products.store_id，因为库存由 inventory 表定义）
            const [skuRows] = await conn.execute(
                `SELECT s.id, p.id AS product_id, p.name, s.specName
                 FROM skus s
                 JOIN products p ON s.product_id = p.id
                 WHERE s.id = ? AND p.merchant_id = ?`,
                [sku_id, merchant_id]
            );
            
            if (skuRows.length === 0) {
                throw new Error('SKU not found or does not belong to this merchant');
            }
            
            adjustedName = `${skuRows[0].name} (${skuRows[0].specName})`;
            finalProductId = skuRows[0].product_id;

            // Phase 3: Keep inventory table in sync (SKU level)
            await conn.execute(
                `INSERT INTO inventory (id, merchant_id, store_id, product_id, sku_id, stock, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(id) DO UPDATE SET stock = stock + excluded.stock, updated_at = excluded.updated_at`,
                [`inv_s_${sku_id}_${target_store_id}`, merchant_id, target_store_id, finalProductId, sku_id, qty, Date.now(), qty, Date.now()]
            );
            
        } else if (product_id) {
            const [productRows] = await conn.execute(
                `SELECT id, name FROM products WHERE id = ? AND merchant_id = ?`,
                [product_id, merchant_id]
            );
            
            if (productRows.length === 0) {
                throw new Error('Product not found or does not belong to this merchant');
            }
            
            adjustedName = productRows[0].name;

            // Phase 3: Keep inventory table in sync (Product level)
            await conn.execute(
                `INSERT INTO inventory (id, merchant_id, store_id, product_id, sku_id, stock, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(id) DO UPDATE SET stock = stock + excluded.stock, updated_at = excluded.updated_at`,
                [`inv_p_${product_id}_${target_store_id}`, merchant_id, target_store_id, product_id, '', qty, Date.now(), qty, Date.now()]
            );
        }

        // Write Inventory Movement
        const movement_id = require('../id_utils').generateId();
        await conn.execute(
            `INSERT INTO inventory_movements (id, merchant_id, store_id, product_id, sku_id, type, qty, ref_id, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [movement_id, merchant_id, target_store_id, finalProductId || '', sku_id || null, type || 'adjust', qty, reason || 'manual_adjustment', Date.now()]
        );
        
        // Write Audit Log
        await conn.execute(
            `INSERT INTO audit_logs (merchant_id, action, details, time, store_id, user_id, username) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [merchant_id, 'INVENTORY_ADJUST', JSON.stringify({ item: adjustedName, product_id: finalProductId, sku_id, qty, reason }), Date.now(), target_store_id, req.user.id, req.user.username]
        );

        await conn.commit();
        conn.release();

        // Enqueue inventory movement for sync
        syncService.enqueue({
            merchant_id,
            store_id: target_store_id,
            entity_type: 'inventory_movement',
            entity_id: movement_id,
            operation: 'create',
            payload: { movement_id, product_id: finalProductId, sku_id, qty, type, store_id: target_store_id }
        });

        ApiResponse.success(res, { movement_id, target_store_id, qty_adjusted: qty }, 'Inventory adjusted successfully');
    } catch (err) {
        if (conn) {
            await conn.rollback();
            conn.release();
        }
        return ApiResponse.error(res, err.message, 400);
    }
}));

module.exports = router;
