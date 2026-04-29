const express = require('express');
const router = express.Router();
const db = require('../db');
const syncService = require('../sync_service');
const { ApiResponse, asyncHandler } = require('../utils');
const { authenticate } = require('../middleware/auth');
const { requireRole, requireActiveUser } = require('../middleware/rbac');
const { generateId } = require('../id_utils');
const logger = require('../logger');

// 获取退款单列表
router.get('/', authenticate, requireActiveUser, requireRole(['merchant_admin', 'store_manager', 'cashier']), asyncHandler(async (req, res) => {
    const merchant_id = req.user.merchant_id;
    const { status, store_id } = req.query;
    const ownStoreId = req.user.store_id || req.effectiveStoreId || null;

    if (req.user.role !== 'merchant_admin' && store_id && store_id !== ownStoreId) {
        return ApiResponse.error(res, 'Access denied. You do not have permission to access this store.', 403, 403);
    }

    let sql = `
        SELECT r.*, t.store_id, t.order_no, t.total as order_total, u.name as requester_name
        FROM refunds r 
        JOIN transactions t ON r.order_id = t.id 
        LEFT JOIN users u ON r.requested_by = u.id
        WHERE t.merchant_id = ?
    `;
    const params = [merchant_id];

    if (status) {
        sql += ' AND r.status = ?';
        params.push(status);
    }

    if (req.user.role !== 'merchant_admin') {
        sql += ' AND t.store_id = ?';
        params.push(ownStoreId);
    } else if (store_id) {
        sql += ' AND t.store_id = ?';
        params.push(store_id);
    }

    sql += ' ORDER BY r.created_at DESC';

    const [rows] = await db.query(sql, params);
    ApiResponse.success(res, rows);
}));

// 发起退款申请 (收银员、店长、管理员都可以发起)
router.post('/', authenticate, requireActiveUser, requireRole(['merchant_admin', 'store_manager', 'cashier']), asyncHandler(async (req, res) => {
    const { order_id, reason, items } = req.body;
    const merchant_id = req.user.merchant_id;
    const requested_by = req.user.id;

    if (!order_id) return ApiResponse.error(res, 'order_id is required', 400);

    const conn = await db.getConnection();
    try {
        await conn.beginTransaction();

        // 验证订单是否存在且状态为 paid 或 partially_refunded
        const [orders] = await conn.execute(
            'SELECT id, store_id, status FROM transactions WHERE id = ? AND merchant_id = ?',
            [order_id, merchant_id]
        );

        if (orders.length === 0) {
            throw new Error('Order not found');
        }

        const order = orders[0];
        if (order.status !== 'paid' && order.status !== 'partially_refunded' && order.status !== 'refund_requested') {
            throw new Error(`Cannot request refund for order in status: ${order.status}`);
        }

        // 店长或收银员只能操作自己门店的订单
        if (req.user.role !== 'merchant_admin' && order.store_id !== req.user.store_id) {
            throw new Error('Unauthorized to request refund for this store');
        }

        const refund_id = generateId();

        // 创建退款记录
        await conn.execute(
            `INSERT INTO refunds (id, merchant_id, order_id, status, reason, requested_by, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [refund_id, merchant_id, order_id, 'requested', reason || '', requested_by, Date.now(), Date.now()]
        );

        // 如果提供了具体退款商品，插入到 refund_items
        if (Array.isArray(items) && items.length > 0) {
            for (const item of items) {
                // 验证商品是否属于该订单
                const [orderItem] = await conn.execute(
                    'SELECT id, product_id, sku_id, price FROM order_items WHERE id = ? AND order_id = ?',
                    [item.order_item_id, order_id]
                );
                if (orderItem.length === 0) {
                    throw new Error(`Item ${item.order_item_id} not found in order ${order_id}`);
                }

                await conn.execute(
                    `INSERT INTO refund_items (id, refund_id, order_item_id, product_id, sku_id, qty, amount, reason)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                    [
                        generateId(), refund_id, item.order_item_id, 
                        orderItem[0].product_id, orderItem[0].sku_id, 
                        item.qty, (item.qty * orderItem[0].price), item.reason || reason || ''
                    ]
                );
            }
        }

        // 更新订单状态为 refund_requested
        await conn.execute(
            'UPDATE transactions SET status = ?, updated_at = ? WHERE id = ?',
            ['refund_requested', Date.now(), order_id]
        );

        // Audit Log
        await conn.execute(
            `INSERT INTO audit_logs (merchant_id, action, details, time, store_id, user_id, username) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [merchant_id, 'REFUND_REQUESTED', JSON.stringify({ order_id, refund_id, items_count: items ? items.length : 'all' }), Date.now(), order.store_id, req.user.id, req.user.username]
        );

        await conn.commit();
        conn.release();

        // Enqueue refund request for sync
        syncService.enqueue({
            merchant_id, store_id,
            entity_type: 'refund',
            entity_id: refund_id,
            operation: 'create',
            payload: { refund_id, order_id, amount, reason, items: refund_items }
        });

        ApiResponse.success(res, { refund_id }, 'Refund requested successfully');
    } catch (err) {
        if (conn) {
            await conn.rollback();
            conn.release();
        }
        logger.error('Refund operation failed', err);
        return ApiResponse.error(res, err.message, 400);
    }
}));

// 审批通过退款 (仅限店长和管理员)
router.patch('/:id/approve', authenticate, requireActiveUser, requireRole(['merchant_admin', 'store_manager']), asyncHandler(async (req, res) => {
    const refund_id = req.params.id;
    const merchant_id = req.user.merchant_id;
    const approved_by = req.user.id;

    const conn = await db.getConnection();
    try {
        await conn.beginTransaction();

        // 获取退款单和关联的订单
        const [refunds] = await conn.execute(
            'SELECT r.id, r.order_id, r.status, t.store_id, t.total FROM refunds r JOIN transactions t ON r.order_id = t.id WHERE r.id = ? AND t.merchant_id = ?',
            [refund_id, merchant_id]
        );

        if (refunds.length === 0) throw new Error('Refund request not found');
        const refund = refunds[0];

        if (refund.status !== 'requested') {
            throw new Error(`Cannot approve refund in status: ${refund.status}`);
        }

        // 获取本次退款的具体明细
        const [refundItems] = await conn.execute(
            'SELECT * FROM refund_items WHERE refund_id = ?',
            [refund_id]
        );

        let itemsToReplenish = [];
        if (refundItems.length > 0) {
            // 部分退款口径
            itemsToReplenish = refundItems;
        } else {
            // 整单退款 (兼容历史数据或旧接口)
            const [orderItems] = await conn.execute(
                'SELECT id as order_item_id, product_id, sku_id, qty FROM order_items WHERE order_id = ?',
                [refund.order_id]
            );
            itemsToReplenish = orderItems;
        }

        for (const item of itemsToReplenish) {
             // 加上库存 (Phase 3+: Use inventory table)
             const sku_key = item.sku_id || '';
             await conn.execute(
                 'UPDATE inventory SET stock = stock + ?, updated_at = ? WHERE merchant_id = ? AND store_id = ? AND product_id = ? AND sku_id = ?',
                 [item.qty, Date.now(), merchant_id, refund.store_id, item.product_id, sku_key]
             );

             // 记录库存流水
             const movement_id = generateId();
             await conn.execute(
                 `INSERT INTO inventory_movements (id, merchant_id, store_id, product_id, sku_id, type, qty, ref_id, created_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                 [movement_id, merchant_id, refund.store_id, item.product_id || '', item.sku_id || null, 'refund', item.qty, refund_id, Date.now()]
             );
        }

        // 更新退款单状态
        await conn.execute(
            'UPDATE refunds SET status = ?, approved_by = ?, updated_at = ? WHERE id = ?',
            ['approved', approved_by, Date.now(), refund_id]
        );

        // 判定订单最终状态
        // 计算该订单所有已通过退款的累计商品数量
        const [allRefunded] = await conn.execute(
            `SELECT SUM(ri.qty) as total_qty 
             FROM refund_items ri 
             JOIN refunds r ON ri.refund_id = r.id 
             WHERE r.order_id = ? AND r.status = 'approved'`,
            [refund.order_id]
        );
        const [allOrdered] = await conn.execute(
            'SELECT SUM(qty) as total_qty FROM order_items WHERE order_id = ?',
            [refund.order_id]
        );

        const totalRefundedQty = Number(allRefunded[0].total_qty || 0);
        const totalOrderedQty = Number(allOrdered[0].total_qty || 0);

        let finalStatus = 'partially_refunded';
        let finalPaymentStatus = 'paid';

        // 如果累计退款数量 >= 订单数量，或者这是个老的整单退款，则标记为已全额退款
        if (totalRefundedQty >= totalOrderedQty || refundItems.length === 0) {
            finalStatus = 'refunded';
            finalPaymentStatus = 'refunded';
        }

        await conn.execute(
            'UPDATE transactions SET status = ?, payment_status = ?, updated_at = ? WHERE id = ?',
            [finalStatus, finalPaymentStatus, Date.now(), refund.order_id]
        );

        // Audit Log
        await conn.execute(
            `INSERT INTO audit_logs (merchant_id, action, details, time, store_id, user_id, username) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [merchant_id, 'REFUND_APPROVED', JSON.stringify({ refund_id, order_id: refund.order_id, final_status: finalStatus }), Date.now(), refund.store_id, req.user.id, req.user.username]
        );

        await conn.commit();
        conn.release();

        // Enqueue refund approval for sync
        syncService.enqueue({
            merchant_id, store_id: refund.store_id,
            entity_type: 'refund',
            entity_id: refund_id,
            operation: 'update',
            payload: { refund_id, status: finalStatus, approved_amount: totalRefundAmount }
        });

        ApiResponse.success(res, { status: finalStatus }, 'Refund approved and inventory replenished');
    } catch (err) {
        if (conn) {
            await conn.rollback();
            conn.release();
        }
        logger.error('Refund operation failed', err);
        return ApiResponse.error(res, err.message, 400);
    }
}));

// 拒绝退款申请
router.patch('/:id/reject', authenticate, requireActiveUser, requireRole(['merchant_admin', 'store_manager']), asyncHandler(async (req, res) => {
    const refund_id = req.params.id;
    const merchant_id = req.user.merchant_id;
    const { reason } = req.body;

    const conn = await db.getConnection();
    try {
         await conn.beginTransaction();

         const [refunds] = await conn.execute(
             'SELECT r.id, r.order_id, r.status, t.store_id FROM refunds r JOIN transactions t ON r.order_id = t.id WHERE r.id = ? AND t.merchant_id = ?',
             [refund_id, merchant_id]
         );

         if (refunds.length === 0) throw new Error('Refund request not found');
         const refund = refunds[0];

         if (refund.status !== 'requested') {
             throw new Error(`Cannot reject refund in status: ${refund.status}`);
         }

         if (req.user.role === 'store_manager' && refund.store_id !== req.user.store_id) {
             throw new Error('Unauthorized to reject refund for this store');
         }

         // 将退款单置为已拒绝
         await conn.execute(
             'UPDATE refunds SET status = ?, reason = reason || ?, updated_at = ? WHERE id = ?',
             ['rejected', reason ? ` (拒退原因: ${reason})` : '', Date.now(), refund_id]
         );

         // 将订单恢复为 paid
         await conn.execute(
             'UPDATE transactions SET status = ?, updated_at = ? WHERE id = ?',
             ['paid', Date.now(), refund.order_id]
         );

         // Audit Log
         await conn.execute(
             `INSERT INTO audit_logs (merchant_id, action, details, time, store_id, user_id, username) VALUES (?, ?, ?, ?, ?, ?, ?)`,
             [merchant_id, 'REFUND_REJECTED', JSON.stringify({ refund_id, order_id: refund.order_id }), Date.now(), refund.store_id, req.user.id, req.user.username]
         );

         await conn.commit();
         conn.release();

         ApiResponse.success(res, null, 'Refund rejected manually');
    } catch(err) {
         await conn.rollback();
         conn.release();
         logger.error('Refund rejection failed', err);
         return ApiResponse.error(res, err.message, 400);
    }
}));

module.exports = router;
