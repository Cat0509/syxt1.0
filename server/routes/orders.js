const express = require('express');
const router = express.Router();
const db = require('../db');
const { ApiResponse, asyncHandler } = require('../utils');
const { authenticate } = require('../middleware/auth');
const { requireRole, requireActiveUser, requireStoreScope } = require('../middleware/rbac');
const { generateId, generateOrderNo } = require('../id_utils');
const logger = require('../logger');

// GET /orders - 获取订单列表 (支持筛选)
router.get('/', authenticate, requireActiveUser, requireRole(['merchant_admin', 'store_manager', 'cashier']), requireStoreScope, asyncHandler(async (req, res) => {
    const { store_id, start_time, end_time, status, order_id, payment_status, client_tx_id } = req.query;
    const merchant_id = req.user.merchant_id;
    
    // RBAC: store_manager and cashier can only see their own store's orders
    let targetStoreId = req.effectiveStoreId;
    if (req.user.role === 'merchant_admin' && store_id) {
        targetStoreId = store_id;
    }

    const filters = {
        storeId: targetStoreId,
        orderId: order_id || null,
        startTime: start_time ? parseInt(start_time) : null,
        endTime: end_time ? parseInt(end_time) : null,
        status: status || null,
        paymentStatus: payment_status || null,
        clientTxId: client_tx_id || null
    };

    const orders = await db.getTransactions(merchant_id, filters);
    ApiResponse.success(res, orders);
}));

router.post('/', authenticate, requireActiveUser, requireRole(['merchant_admin', 'store_manager', 'cashier']), requireStoreScope, asyncHandler(async (req, res) => {
    const { items, total, amount, payment = {}, order_no = null, client_tx_id, payment_method = 'scan', device_id = null } = req.body;
    const merchant_id = req.user.merchant_id;
    const store_id = req.effectiveStoreId;
    const cashier_id = req.user.id;
    
    // Validate request
    if (!items || !Array.isArray(items) || items.length === 0) {
        return ApiResponse.error(res, 'Order must contain items', 400);
    }
    
    
    if (!client_tx_id) {
         return ApiResponse.error(res, 'client_tx_id is required for idempotency', 400);
    }

    if (!store_id) {
         return ApiResponse.error(res, 'Store ID is required for creating an order', 400);
    }

    const conn = await db.getConnection();
    try {
        await conn.beginTransaction();

        // Check Idempotency
        const [existing] = await conn.execute('SELECT id FROM transactions WHERE client_tx_id = ? AND merchant_id = ?', [client_tx_id, merchant_id]);
        if (existing.length > 0) {
            await conn.rollback();
            conn.release();
            return ApiResponse.error(res, 'Duplicate order (idempotency constraint)', 409, 409); // 409 Conflict
        }

        const transaction_id = generateId();
        const auto_order_no = order_no || generateOrderNo(store_id);
        
        // 1. Create Transaction (Order)
        // Note: items column now stores an empty array to comply with schema but decouple from JSON logic
        await conn.execute(
            `INSERT INTO transactions 
             (id, merchant_id, time, items, total, amount, payment, processed_by, store_id, updated_at, order_no, status, payment_status, payment_method, cashier_id, client_tx_id, device_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                transaction_id, merchant_id, Date.now(), '[]', total, amount, JSON.stringify(payment), req.user.username, store_id, Date.now(), auto_order_no, 'pending', 'unpaid', payment_method || 'scan', cashier_id, client_tx_id, device_id
            ]
        );

        // 2. Process Items and Deduct Inventory (Phase 3: Use inventory table)
        for (const item of items) {
            // Check inventory table instead of skus/products
            const sku_key = item.sku_id || '';
            const [invRows] = await conn.execute(
                'SELECT stock FROM inventory WHERE merchant_id = ? AND store_id = ? AND product_id = ? AND sku_id = ? FOR UPDATE',
                [merchant_id, store_id, item.product_id, sku_key]
            );

            if (invRows.length === 0 || invRows[0].stock < item.qty) {
                 throw new Error(`Insufficient stock for ${item.name} (Available: ${invRows.length > 0 ? invRows[0].stock : 0})`);
            }

            // Deduct from inventory table
            await conn.execute(
                'UPDATE inventory SET stock = stock - ?, updated_at = ? WHERE merchant_id = ? AND store_id = ? AND product_id = ? AND sku_id = ?',
                [item.qty, Date.now(), merchant_id, store_id, item.product_id, sku_key]
            );
            
            // Write Order Item
            const item_id = generateId();
            await conn.execute(
                `INSERT INTO order_items (id, order_id, product_id, sku_id, name, price, qty, subtotal)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [item_id, transaction_id, item.product_id || null, item.sku_id || null, item.name, item.price, item.qty, item.qty * item.price]
            );

            // Write Inventory Movement
            const movement_id = generateId();
            await conn.execute(
                `INSERT INTO inventory_movements (id, merchant_id, store_id, product_id, sku_id, type, qty, ref_id, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [movement_id, merchant_id, store_id, item.product_id || '', item.sku_id || null, 'sale', -item.qty, transaction_id, Date.now()]
            );
        }

        // 3. Write Audit Log
        await conn.execute(
            `INSERT INTO audit_logs (merchant_id, action, details, time, store_id) VALUES (?, ?, ?, ?, ?)`,
            [merchant_id, 'CREATE_ORDER', JSON.stringify({ order_no: auto_order_no, total }), Date.now(), store_id]
        );

        await conn.commit();
        conn.release();

        ApiResponse.success(res, { order_id: transaction_id, order_no: auto_order_no }, 'Order created successfully');
    } catch (err) {
        await conn.rollback();
        conn.release();
        logger.error('Order creation failed', err);
        return ApiResponse.error(res, err.message, 400);
    }
}));

// POST /orders/replay - 批量回放离线订单 (离线重放接口)
router.post('/replay', authenticate, requireActiveUser, requireRole(['merchant_admin', 'store_manager', 'cashier']), requireStoreScope, asyncHandler(async (req, res) => {
    const { orders } = req.body;
    if (!Array.isArray(orders) || orders.length === 0) {
        return ApiResponse.error(res, 'orders array is required', 400);
    }

    const results = [];
    for (const orderPayload of orders) {
        const { items, total, amount, payment, order_no, client_tx_id, payment_method, store_id, device_id = null } = orderPayload;
        const merchant_id = req.user.merchant_id;

        if (!client_tx_id) {
            results.push({ client_tx_id: null, code: 400, message: 'client_tx_id missing' });
            continue;
        }

        // Use direct pool query (idempotency guaranteed inside transaction below)
        const conn = await db.getConnection();
        try {
            await conn.beginTransaction();

            const [dup] = await conn.execute('SELECT id FROM transactions WHERE client_tx_id = ? AND merchant_id = ?', [client_tx_id, merchant_id]);
            if (dup.length > 0) {
                await conn.rollback();
                conn.release();
                results.push({ client_tx_id, code: 409, message: 'Already synced' });
                continue;
            }

            const effective_store_id = store_id || req.effectiveStoreId;
            if (!effective_store_id) {
                await conn.rollback();
                conn.release();
                results.push({ client_tx_id, code: 400, message: 'store_id is required' });
                continue;
            }

            const transaction_id = generateId();
            const auto_order_no = order_no || generateOrderNo(effective_store_id);

            await conn.execute(
                `INSERT INTO transactions (id, merchant_id, time, items, total, amount, payment, processed_by, store_id, updated_at, order_no, status, payment_status, payment_method, cashier_id, client_tx_id, device_id)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [transaction_id, merchant_id, Date.now(), '[]', total, amount, JSON.stringify(payment || {}), req.user.username, effective_store_id, Date.now(), auto_order_no, 'paid', 'paid', payment_method || 'scan', req.user.id, client_tx_id, device_id]
            );

            if (items && Array.isArray(items)) {
                for (const item of items) {
                    const sku_key = item.sku_id || '';
                    const [invRows] = await conn.execute(
                        'SELECT stock FROM inventory WHERE merchant_id = ? AND store_id = ? AND product_id = ? AND sku_id = ?',
                        [merchant_id, effective_store_id, item.product_id, sku_key]
                    );
                    if (invRows.length > 0 && invRows[0].stock >= item.qty) {
                        await conn.execute(
                            'UPDATE inventory SET stock = stock - ?, updated_at = ? WHERE merchant_id = ? AND store_id = ? AND product_id = ? AND sku_id = ?',
                            [item.qty, Date.now(), merchant_id, effective_store_id, item.product_id, sku_key]
                        );
                    } else {
                        // Strict mode: Fail the replay if stock is insufficient
                        throw new Error(`Insufficient stock for ${item.name} during replay`);
                    }
                    const item_id = generateId();
                    await conn.execute(
                        `INSERT INTO order_items (id, order_id, product_id, sku_id, name, price, qty, subtotal) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                        [item_id, transaction_id, item.product_id || null, item.sku_id || null, item.name, item.price, item.qty, item.qty * item.price]
                    );

                    const movement_id = generateId();
                    await conn.execute(
                        `INSERT INTO inventory_movements (id, merchant_id, store_id, product_id, sku_id, type, qty, ref_id, created_at)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                        [movement_id, merchant_id, effective_store_id, item.product_id || '', item.sku_id || null, 'sale', -item.qty, transaction_id, Date.now()]
                    );
                }
            }

            await conn.commit();
            conn.release();
            results.push({ client_tx_id, code: 200, order_id: transaction_id });
        } catch (err) {
            await conn.rollback();
            conn.release();
            results.push({ client_tx_id, code: 400, message: err.message });
        }
    }

    ApiResponse.success(res, { results }, 'Replay complete');
}));

module.exports = router;
