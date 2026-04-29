const express = require('express');
const router = express.Router();
const db = require('../db');
const syncService = require('../sync_service');
const { ApiResponse, asyncHandler } = require('../utils');
const { authenticate } = require('../middleware/auth');
const { requireActiveUser, requireRole } = require('../middleware/rbac');
const logger = require('../logger');

// ---------------------------------------------------------------------------
// Health check & metadata
// ---------------------------------------------------------------------------
router.get('/heartbeat', async (req, res) => {
    try {
        const merchantCount = await db.getMerchantCount();
        ApiResponse.success(res, {
            status: 'online',
            serverTime: new Date().toISOString(),
            initialized: merchantCount > 0,
            version: '5.1.0-sqlite'
        });
    } catch (err) {
        logger.error('Sync Heartbeat failed', err);
        ApiResponse.error(res, 'Sync service unavailable', 500);
    }
});

// ---------------------------------------------------------------------------
// Sync status (local queue stats)
// ---------------------------------------------------------------------------
router.get('/status', authenticate, requireActiveUser, asyncHandler(async (req, res) => {
    const stats = syncService.getSyncStats();
    ApiResponse.success(res, {
        ...stats,
        sync_running: syncService.isSyncRunning(),
        hq_url: process.env.HQ_SYNC_URL || null
    });
}));

// ---------------------------------------------------------------------------
// Manual sync trigger
// ---------------------------------------------------------------------------
router.post('/trigger', authenticate, requireActiveUser, requireRole(['merchant_admin', 'store_manager']), asyncHandler(async (req, res) => {
    const hqUrl = process.env.HQ_SYNC_URL || null;
    const merchantId = req.user.merchant_id;
    const storeId = req.user.store_id;

    try {
        // Upload pending items
        const uploadResult = await syncService.uploadToHQ(hqUrl);

        // Download from HQ (if configured)
        let downloadResult = { products: 0, prices: 0, users: 0 };
        if (hqUrl && merchantId) {
            downloadResult = await syncService.downloadFromHQ(hqUrl, merchantId, storeId);
        }

        ApiResponse.success(res, {
            upload: uploadResult,
            download: downloadResult,
            queue_stats: syncService.getSyncStats()
        }, '同步完成');
    } catch (err) {
        logger.error('Manual sync failed', err);
        ApiResponse.error(res, '同步失败: ' + err.message, 500);
    }
}));

// ---------------------------------------------------------------------------
// Start/stop sync loop
// ---------------------------------------------------------------------------
router.post('/loop/start', authenticate, requireActiveUser, requireRole(['merchant_admin']), asyncHandler(async (req, res) => {
    const hqUrl = req.body.hq_url || process.env.HQ_SYNC_URL || null;
    const merchantId = req.user.merchant_id;
    const storeId = req.user.store_id;

    syncService.startSyncLoop({ hqUrl, merchantId, storeId });
    ApiResponse.success(res, { running: true }, '同步循环已启动');
}));

router.post('/loop/stop', authenticate, requireActiveUser, requireRole(['merchant_admin']), asyncHandler(async (req, res) => {
    syncService.stopSyncLoop();
    ApiResponse.success(res, { running: false }, '同步循环已停止');
}));

// ---------------------------------------------------------------------------
// View pending queue items
// ---------------------------------------------------------------------------
router.get('/queue', authenticate, requireActiveUser, requireRole(['merchant_admin', 'store_manager']), asyncHandler(async (req, res) => {
    const { status = 'pending', limit = 100 } = req.query;
    const items = syncService.getPendingItems(Number(limit));

    // Filter by status if requested
    const filtered = status === 'all' ? items : items.filter(i => i.sync_status === status);
    ApiResponse.success(res, filtered);
}));

// ---------------------------------------------------------------------------
// HQ receive endpoint (for receiving data from store clients)
// This is the endpoint that store clients POST to when uploading data.
// In single-server mode, this is a no-op since data is already local.
// ---------------------------------------------------------------------------
router.post('/receive', asyncHandler(async (req, res) => {
    const { queue_id, merchant_id, store_id, entity_type, entity_id, operation, payload, client_timestamp } = req.body;

    if (!entity_type || !entity_id) {
        return ApiResponse.error(res, 'entity_type and entity_id are required', 400);
    }

    // HQ receive: write data into local database based on entity_type
    // This endpoint is idempotent: duplicate entity_id + entity_type will be ignored
    logger.info(`[Sync/HQ] Received ${entity_type}:${entity_id} from store ${store_id || 'unknown'}`);

    try {
        const sqliteDb = db.getDb();

        switch (entity_type) {
            case 'order': {
                // Orders are immutable once created — use INSERT OR IGNORE
                const orderData = payload;
                sqliteDb.prepare(`
                    INSERT OR IGNORE INTO transactions (id, merchant_id, store_id, order_no, time, items, total, amount, payment_method, status, payment_status, cashier_id, device_id, client_tx_id, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `).run(
                    entity_id,
                    merchant_id || '',
                    store_id || '',
                    orderData.order_no || '',
                    client_timestamp || Date.now(),
                    JSON.stringify(orderData.items || []),
                    String(orderData.total || 0),
                    String(orderData.amount || 0),
                    orderData.payment_method || null,
                    'paid',
                    'paid',
                    orderData.cashier_id || null,
                    orderData.device_id || null,
                    orderData.client_tx_id || null,
                    client_timestamp || Date.now()
                );
                break;
            }
            case 'payment': {
                sqliteDb.prepare(`
                    INSERT OR IGNORE INTO order_payments (id, merchant_id, store_id, order_id, method, amount, status, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, 'success', ?)
                `).run(
                    entity_id,
                    merchant_id || '',
                    store_id || '',
                    payload.order_id || '',
                    payload.method || 'cash',
                    String(payload.amount || 0),
                    client_timestamp || Date.now()
                );
                break;
            }
            case 'refund': {
                sqliteDb.prepare(`
                    INSERT OR IGNORE INTO refunds (id, merchant_id, store_id, order_id, amount, reason, status, requested_by, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                `).run(
                    entity_id,
                    merchant_id || '',
                    store_id || '',
                    payload.order_id || '',
                    String(payload.amount || 0),
                    payload.reason || '',
                    payload.status || 'pending',
                    payload.requested_by || null,
                    client_timestamp || Date.now()
                );
                break;
            }
            case 'inventory_movement': {
                sqliteDb.prepare(`
                    INSERT OR IGNORE INTO inventory_movements (id, merchant_id, store_id, product_id, sku_id, type, qty, ref_id, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                `).run(
                    entity_id,
                    merchant_id || '',
                    store_id || '',
                    payload.product_id || '',
                    payload.sku_id || null,
                    payload.type || 'sale',
                    Number(payload.qty || 0),
                    payload.ref_id || null,
                    client_timestamp || Date.now()
                );
                break;
            }
            case 'audit_log': {
                sqliteDb.prepare(`
                    INSERT OR IGNORE INTO audit_logs (merchant_id, action, details, time, store_id, user_id, username)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                `).run(
                    merchant_id || '',
                    payload.action || '',
                    JSON.stringify(payload.details || {}),
                    client_timestamp || Date.now(),
                    store_id || null,
                    payload.user_id || null,
                    payload.username || 'remote'
                );
                break;
            }
            default:
                logger.warn(`[Sync/HQ] Unknown entity_type: ${entity_type}, skipping`);
        }

        ApiResponse.success(res, {
            received: true,
            written: true,
            queue_id,
            entity_type,
            entity_id,
            server_timestamp: Date.now()
        });
    } catch (err) {
        logger.error(`[Sync/HQ] Failed to write ${entity_type}:${entity_id}`, err);
        ApiResponse.error(res, 'Failed to write data: ' + err.message, 500);
    }
}));

// ---------------------------------------------------------------------------
// HQ data distribution endpoints (for store clients to pull master data)
// These return data that HQ has but the store may not have yet.
// In single-server mode, the store already has all data locally.
// ---------------------------------------------------------------------------
router.get('/products', authenticate, requireActiveUser, asyncHandler(async (req, res) => {
    const { merchant_id, since = 0 } = req.query;
    if (!merchant_id) {
        return ApiResponse.error(res, 'merchant_id is required', 400);
    }

    // Return products updated after 'since' timestamp
    const products = await db.getProducts(merchant_id, null);
    const filtered = products.filter(p => Number(p.updated_at || 0) > Number(since));
    ApiResponse.success(res, filtered);
}));

router.get('/prices', authenticate, requireActiveUser, asyncHandler(async (req, res) => {
    const { merchant_id, store_id, since = 0 } = req.query;
    if (!merchant_id || !store_id) {
        return ApiResponse.error(res, 'merchant_id and store_id are required', 400);
    }

    try {
        const sqliteDb = db.getDb();
        const rows = sqliteDb.prepare(
            `SELECT * FROM store_prices 
             WHERE merchant_id = ? AND store_id = ? AND updated_at > ?
             ORDER BY updated_at ASC`
        ).all(merchant_id, store_id, Number(since));
        ApiResponse.success(res, rows);
    } catch (err) {
        ApiResponse.error(res, 'Failed to fetch prices', 500);
    }
}));

router.get('/users', authenticate, requireActiveUser, asyncHandler(async (req, res) => {
    const { merchant_id, since = 0 } = req.query;
    if (!merchant_id) {
        return ApiResponse.error(res, 'merchant_id is required', 400);
    }

    const users = await db.getUsers(merchant_id, null);
    const filtered = users.filter(u => Number(u.updated_at || 0) > Number(since));
    // Don't send password hashes to clients
    const safe = filtered.map(({ password, password_hash, ...rest }) => rest);
    ApiResponse.success(res, safe);
}));

// ---------------------------------------------------------------------------
// Device status
// ---------------------------------------------------------------------------
router.get('/status/:deviceId', async (req, res) => {
    const { deviceId } = req.params;
    try {
        const device = await db.getDeviceById(deviceId);
        if (!device) {
            return ApiResponse.error(res, 'Device not recognized', 404);
        }
        ApiResponse.success(res, {
            device_id: device.id,
            last_sync_at: device.last_login_at,
            name: device.name,
            is_active: device.status === 'active'
        });
    } catch (err) {
        logger.error(`Failed to get status for device ${deviceId}`, err);
        ApiResponse.error(res, 'Database error');
    }
});

module.exports = router;
