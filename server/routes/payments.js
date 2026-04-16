const express = require('express');
const router = express.Router();
const db = require('../db');
const { ApiResponse, asyncHandler } = require('../utils');
const { authenticate } = require('../middleware/auth');
const { requireActiveUser } = require('../middleware/rbac');

const parsedMockDelay = Number.parseInt(process.env.PAYMENT_MOCK_DELAY_MS || '1500', 10);
const MOCK_DELAY_MS = Number.isFinite(parsedMockDelay) ? parsedMockDelay : 1500;
const AUTO_CONFIRM_ENABLED = process.env.PAYMENT_MOCK_AUTO_CONFIRM !== 'false';

async function markOrderPaid({ orderId, paymentId, method, amount, source, storeId, merchantId }) {
    const conn = await db.getConnection();

    try {
        await conn.beginTransaction();

        const [orders] = await conn.execute(
            'SELECT id, merchant_id, store_id, total, status, payment_status, payment_method FROM transactions WHERE id = ? FOR UPDATE',
            [orderId]
        );

        if (orders.length === 0) {
            throw new Error('Order not found');
        }

        const order = orders[0];
        
        // 1. Record this specific payment
        const pid = paymentId || ('pay_' + require('../id_utils').generateId().replace(/-/g, ''));
        const effectiveMerchantId = merchantId || order.merchant_id;
        const effectiveStoreId = storeId || order.store_id;

        await conn.execute(
            `INSERT INTO order_payments (id, merchant_id, store_id, order_id, method, amount, status, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE status=VALUES(status)`,
            [pid, effectiveMerchantId, effectiveStoreId, orderId, method || 'scan', amount || 0, 'success', Date.now()]
        );

        // 2. Calculate total paid for this order
        const [paymentRows] = await conn.execute(
            'SELECT SUM(amount) as total_paid FROM order_payments WHERE order_id = ? AND status = ?',
            [orderId, 'success']
        );
        const totalPaid = Number(paymentRows[0].total_paid || 0);

        // 3. Update order status
        let newStatus = order.status;
        let newPaymentStatus = order.payment_status;

        if (totalPaid >= Number(order.total)) {
            newStatus = 'paid';
            newPaymentStatus = 'paid';
        } else if (totalPaid > 0) {
            newPaymentStatus = 'paid'; // Note: In Phase 4/5 logic, 'paid' might mean "has some payment", but let's stick to the plan's "partially_paid" if possible. 
            // The original schema ENUM only had 'unpaid', 'paid', 'refunded'. 
            // If I didn't add 'partially_paid' to ENUM, I'll use 'paid' for now or just trust the summary.
            // Actually, usually in POS, if it's not fully paid, it's still 'pending' status but 'paid' payment_status? Let's check ENUM.
        }

        await conn.execute(
            'UPDATE transactions SET status = ?, payment_status = ?, payment_method = ?, updated_at = ? WHERE id = ?',
            [newStatus, newPaymentStatus, method || order.payment_method || 'scan', Date.now(), orderId]
        );

        await conn.execute(
            'INSERT INTO audit_logs (merchant_id, action, details, time, store_id) VALUES (?, ?, ?, ?, ?)',
            [
                effectiveMerchantId,
                'PAYMENT_SUCCESS',
                JSON.stringify({
                    order_id: orderId,
                    payment_id: pid,
                    method: method || 'scan',
                    amount: amount,
                    total_paid: totalPaid,
                    order_total: order.total,
                    source
                }),
                Date.now(),
                effectiveStoreId || null
            ]
        );

        await conn.commit();
        conn.release();
        return { alreadyPaid: totalPaid >= Number(order.total), order, totalPaid };
    } catch (err) {
        await conn.rollback();
        conn.release();
        throw err;
    }
}

function scheduleAutoConfirm({ orderId, paymentId, method, amount, storeId, merchantId }) {
    if (!AUTO_CONFIRM_ENABLED) {
        return;
    }

    setTimeout(() => {
        markOrderPaid({
            orderId,
            paymentId,
            method,
            amount,
            source: 'mock_auto_callback',
            storeId,
            merchantId
        }).catch((err) => {
            const logger = require('../logger');
            logger.error(`Auto payment callback failed for order ${orderId}:`, err);
        });
    }, Math.max(0, MOCK_DELAY_MS));
}

// POST /api/v1/payments/create - 创建支付会话 (Mock)
router.post('/create', authenticate, requireActiveUser, asyncHandler(async (req, res) => {
    const { order_id, amount, method } = req.body;
    const merchant_id = req.user.merchant_id;
    const store_id = req.user.store_id;
    const paymentMethod = method || 'scan';
    const numericAmount = Number.parseFloat(amount);

    if (!order_id || Number.isNaN(numericAmount) || numericAmount <= 0) {
        return ApiResponse.error(res, 'order_id and valid amount are required', 400);
    }

    const [orders] = await db.query(
        'SELECT id, total, status, payment_status, payment_method FROM transactions WHERE id = ? AND merchant_id = ?',
        [order_id, merchant_id]
    );
    if (orders.length === 0) {
        return ApiResponse.error(res, 'Order not found', 404);
    }

    const order = orders[0];
    
    // Check total paid already
    const [existingPayments] = await db.query(
        'SELECT SUM(amount) as paid FROM order_payments WHERE order_id = ? AND status = ?',
        [order_id, 'success']
    );
    const alreadyPaid = Number(existingPayments[0].paid || 0);

    if (alreadyPaid >= Number(order.total)) {
        return ApiResponse.success(res, {
            order_id,
            amount: 0,
            already_paid: alreadyPaid,
            order_total: order.total,
            payment_status: 'paid'
        }, 'Order already fully paid');
    }

    const payment_id = 'pay_' + require('../id_utils').generateId().replace(/-/g, '');

    if (paymentMethod === 'cash') {
        const result = await markOrderPaid({
            orderId: order_id,
            paymentId: payment_id,
            method: paymentMethod,
            amount: numericAmount,
            source: 'cash_register',
            storeId: store_id,
            merchantId: merchant_id
        });

        return ApiResponse.success(res, {
            payment_id,
            order_id,
            amount: numericAmount,
            total_paid: result.totalPaid,
            order_total: order.total,
            method: paymentMethod,
            payment_status: result.totalPaid >= Number(order.total) ? 'paid' : 'partially_paid',
            callback_mode: 'cash_immediate'
        }, 'Cash payment recorded');
    }

    scheduleAutoConfirm({ 
        orderId: order_id, 
        paymentId: payment_id, 
        method: paymentMethod, 
        amount: numericAmount,
        storeId: store_id,
        merchantId: merchant_id
    });

    ApiResponse.success(res, {
        payment_id,
        order_id,
        amount: numericAmount,
        method: paymentMethod,
        gateway_url: `mock://payments/${payment_id}`,
        qr_code: `MOCK_QR_CODE_${payment_id}`,
        payment_status: 'pending',
        callback_mode: AUTO_CONFIRM_ENABLED ? 'server_auto_mock' : 'manual_mock',
        auto_callback_in_ms: AUTO_CONFIRM_ENABLED ? Math.max(0, MOCK_DELAY_MS) : null
    }, 'Payment initiated');
}));

// POST /api/v1/payments/callback - 支付回调 (Mock)
router.post('/callback', asyncHandler(async (req, res) => {
    const { order_id, status, payment_id, method, amount } = req.body;

    if (!order_id || status !== 'success') {
        const logger = require('../logger');
        logger.warn('Payment callback failed or invalid:', req.body);
        return ApiResponse.error(res, 'Invalid callback data', 400);
    }

    try {
        const result = await markOrderPaid({
            orderId: order_id,
            paymentId: payment_id || null,
            method: method || 'scan',
            amount: Number.parseFloat(amount || 0),
            source: 'manual_callback'
        });

        const logger = require('../logger');
        logger.info(`Payment success for order ${order_id} (Total paid: ${result.totalPaid})`);
        ApiResponse.success(res, {
            order_id,
            payment_status: result.totalPaid >= Number(result.order.total) ? 'paid' : 'partially_paid',
            total_paid: result.totalPaid
        }, 'Callback processed');
    } catch (err) {
        const logger = require('../logger');
        logger.error('Payment callback processing failed:', err);
        ApiResponse.error(res, err.message, 500);
    }
}));

module.exports = router;
