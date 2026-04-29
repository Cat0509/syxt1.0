/**
 * Ruyi POS - Order Timeout Service
 *
 * 定时检查超时未支付的订单，自动取消并恢复库存。
 * 
 * 配置（通过环境变量）：
 *   ORDER_TIMEOUT_MS  - 订单超时时间，默认 5 分钟（300000ms）
 *   ORDER_CHECK_MS    - 检查间隔，默认 60 秒（60000ms）
 */

const db = require('./db');
const syncService = require('./sync_service');
const { generateId } = require('./id_utils');
const logger = require('./logger');

const ORDER_TIMEOUT_MS = Number.parseInt(process.env.ORDER_TIMEOUT_MS || '300000', 10);
const ORDER_CHECK_MS = Number.parseInt(process.env.ORDER_CHECK_MS || '60000', 10);

let timeoutTimer = null;
let isRunning = false;

/**
 * Check for timed-out pending orders and cancel them.
 * This function is idempotent and safe to call concurrently.
 */
function checkTimeoutOrders() {
    if (isRunning) return;
    isRunning = true;

    try {
        const sqliteDb = db.getDb();
        if (!sqliteDb) return;

        const cutoffTime = Date.now() - ORDER_TIMEOUT_MS;

        // Find all pending orders that have exceeded the timeout
        const expiredOrders = sqliteDb.prepare(
            `SELECT id, merchant_id, store_id, order_no, time as created_at 
             FROM transactions 
             WHERE status = 'pending' AND time < ?`
        ).all(cutoffTime);

        if (expiredOrders.length === 0) return;

        logger.info(`[OrderTimeout] Found ${expiredOrders.length} expired order(s)`);

        for (const order of expiredOrders) {
            try {
                // Use a transaction to ensure atomicity
                const result = sqliteDb.transaction(() => {
                    // 1. Update order status
                    const updateResult = sqliteDb.prepare(
                        "UPDATE transactions SET status = 'cancelled', payment_status = 'unpaid' WHERE id = ? AND status = 'pending'"
                    ).run(order.id);

                    // Check if the update actually changed a row (another process might have already handled it)
                    if (updateResult.changes === 0) return 0;

                    // 2. Get order items to restore inventory
                    const items = sqliteDb.prepare(
                        'SELECT product_id, sku_id, qty FROM order_items WHERE order_id = ?'
                    ).all(order.id);

                    // 3. Restore inventory for each item
                    for (const item of items) {
                        sqliteDb.prepare(
                            `UPDATE inventory 
                             SET stock = stock + ?, updated_at = ? 
                             WHERE merchant_id = ? AND store_id = ? AND product_id = ? AND (sku_id = ? OR (sku_id IS NULL AND ? = ''))`
                        ).run(item.qty, Date.now(), order.merchant_id, order.store_id, item.product_id, item.sku_id || '', item.sku_id || '');

                        // Record inventory movement
                        const movement_id = generateId();
                        sqliteDb.prepare(
                            `INSERT INTO inventory_movements (id, merchant_id, store_id, product_id, sku_id, type, qty, ref_id, created_at)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
                        ).run(movement_id, order.merchant_id, order.store_id, item.product_id || '', item.sku_id || null, 'cancel_restore', item.qty, order.id, Date.now());
                    }

                    // 4. Audit log
                    sqliteDb.prepare(
                        `INSERT INTO audit_logs (merchant_id, action, details, time, store_id, user_id, username) 
                         VALUES (?, ?, ?, ?, ?, ?, ?)`
                    ).run(
                        order.merchant_id,
                        'ORDER_TIMEOUT_CANCEL',
                        JSON.stringify({
                            order_id: order.id,
                            order_no: order.order_no,
                            reason: `订单超时自动取消（超过 ${Math.round(ORDER_TIMEOUT_MS / 60000)} 分钟未支付）`,
                            items_restored: items.length
                        }),
                        Date.now(),
                        order.store_id,
                        null,
                        'system'
                    );

                    return items.length;
                })();

                if (result > 0) {
                    logger.info(`[OrderTimeout] Cancelled order ${order.order_no || order.id}, restored ${result} item(s)`);

                    // Enqueue for sync
                    syncService.enqueue({
                        merchant_id: order.merchant_id,
                        store_id: order.store_id,
                        entity_type: 'order',
                        entity_id: order.id,
                        operation: 'update',
                        payload: {
                            order_id: order.id,
                            order_no: order.order_no,
                            status: 'cancelled',
                            reason: 'timeout',
                            items_restored: result
                        }
                    });
                }
            } catch (err) {
                logger.error(`[OrderTimeout] Failed to cancel order ${order.id}`, err);
            }
        }
    } catch (err) {
        logger.error('[OrderTimeout] Check failed', err);
    } finally {
        isRunning = false;
    }
}

/**
 * Start the order timeout checker.
 */
function startOrderTimeoutChecker() {
    if (timeoutTimer) {
        clearInterval(timeoutTimer);
    }

    logger.info(`[OrderTimeout] Started (timeout: ${ORDER_TIMEOUT_MS / 1000}s, check interval: ${ORDER_CHECK_MS / 1000}s)`);

    // Check immediately on start (with a small delay to let the server fully initialize)
    setTimeout(checkTimeoutOrders, 5000);

    // Then check periodically
    timeoutTimer = setInterval(checkTimeoutOrders, ORDER_CHECK_MS);
}

/**
 * Stop the order timeout checker.
 */
function stopOrderTimeoutChecker() {
    if (timeoutTimer) {
        clearInterval(timeoutTimer);
        timeoutTimer = null;
        logger.info('[OrderTimeout] Stopped');
    }
}

/**
 * Check if the timeout checker is running.
 */
function isCheckerRunning() {
    return timeoutTimer !== null;
}

module.exports = {
    checkTimeoutOrders,
    startOrderTimeoutChecker,
    stopOrderTimeoutChecker,
    isCheckerRunning
};
