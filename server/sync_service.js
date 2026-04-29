/**
 * Ruyi POS - Sync Service
 *
 * 门店端本地同步服务，负责：
 * 1. 在收银操作（订单/支付/退款/库存/审计）完成后，将数据写入 sync_queue
 * 2. 后台定时轮询 sync_queue，将 pending 记录上传至总部
 * 3. 定时从总部拉取主数据（商品/价格/员工/权限）更新本地缓存
 *
 * 设计原则：
 * - 流水数据（订单/支付/退款/库存变动/审计日志）只追加，不可修改
 * - 主数据（商品/价格/员工/权限）按 updated_at 版本号判断新旧
 * - 幂等性：每条 sync_queue 记录有唯一 entity_id + entity_type
 */

const db = require('./db');
const { generateId } = require('./id_utils');
const logger = require('./logger');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const SYNC_INTERVAL_MS = Number.parseInt(process.env.SYNC_INTERVAL_MS || '30000', 10); // 30s
const SYNC_BATCH_SIZE = Number.parseInt(process.env.SYNC_BATCH_SIZE || '50', 10);
const SYNC_MAX_RETRIES = 3;
const SYNC_RETRY_DELAY_MS = 5000;

let syncTimer = null;
let isSyncing = false;

// ---------------------------------------------------------------------------
// Queue: enqueue local changes for upload
// ---------------------------------------------------------------------------

/**
 * Add an entity to the sync queue for later upload.
 * @param {Object} opts
 * @param {string} opts.merchant_id
 * @param {string} opts.store_id
 * @param {string} opts.entity_type - 'order' | 'payment' | 'refund' | 'inventory_movement' | 'audit_log'
 * @param {string} opts.entity_id - The local ID of the entity
 * @param {string} opts.operation - 'create' | 'update' (default: 'create')
 * @param {Object} opts.payload - The full entity data to upload
 */
function enqueue(opts) {
    const { merchant_id, store_id, entity_type, entity_id, operation = 'create', payload } = opts;

    if (!entity_type || !entity_id) {
        logger.warn('[Sync] enqueue called without entity_type or entity_id');
        return;
    }

    try {
        const sqliteDb = db.getDb ? db.getDb() : null;
        if (!sqliteDb) {
            logger.warn('[Sync] Database not initialized, skipping enqueue');
            return;
        }

        // Check for duplicate: same entity_type + entity_id with 'synced' status
        const existing = sqliteDb.prepare(
            `SELECT id, sync_status FROM sync_queue 
             WHERE entity_type = ? AND entity_id = ? AND sync_status != 'failed'`
        ).get(entity_type, entity_id);

        if (existing) {
            // Already queued or synced, skip
            if (existing.sync_status === 'synced') {
                logger.debug(`[Sync] ${entity_type}:${entity_id} already synced, skipping`);
            }
            return;
        }

        sqliteDb.prepare(
            `INSERT INTO sync_queue (id, merchant_id, store_id, entity_type, entity_id, operation, payload, sync_status, attempts, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?)`
        ).run(
            generateId(),
            merchant_id || null,
            store_id || null,
            entity_type,
            entity_id,
            operation,
            JSON.stringify(payload),
            Date.now()
        );

        logger.debug(`[Sync] Enqueued ${entity_type}:${entity_id}`);
    } catch (err) {
        logger.error(`[Sync] Failed to enqueue ${entity_type}:${entity_id}`, err);
    }
}

/**
 * Convenience: enqueue multiple items at once.
 * @param {Array} items - Array of enqueue opts objects
 */
function enqueueMany(items) {
    for (const item of items) {
        enqueue(item);
    }
}

// ---------------------------------------------------------------------------
// Queue: get pending items
// ---------------------------------------------------------------------------

function getPendingItems(limit = SYNC_BATCH_SIZE) {
    try {
        const sqliteDb = db.getDb();
        return sqliteDb.prepare(
            `SELECT * FROM sync_queue 
             WHERE sync_status = 'pending' 
             ORDER BY created_at ASC 
             LIMIT ?`
        ).all(limit);
    } catch (err) {
        logger.error('[Sync] Failed to get pending items', err);
        return [];
    }
}

/**
 * Mark a queue item as synced.
 */
function markSynced(queueId) {
    try {
        const sqliteDb = db.getDb();
        sqliteDb.prepare(
            `UPDATE sync_queue SET sync_status = 'synced', synced_at = ? WHERE id = ?`
        ).run(Date.now(), queueId);
    } catch (err) {
        logger.error(`[Sync] Failed to mark ${queueId} as synced`, err);
    }
}

/**
 * Mark a queue item as failed and increment attempts.
 */
function markFailed(queueId, errorMsg) {
    try {
        const sqliteDb = db.getDb();
        sqliteDb.prepare(
            `UPDATE sync_queue 
             SET sync_status = 'failed', attempts = attempts + 1, last_attempt_at = ? 
             WHERE id = ?`
        ).run(Date.now(), queueId);

        // If max retries exceeded, keep as failed (manual intervention needed)
        const item = sqliteDb.prepare('SELECT attempts FROM sync_queue WHERE id = ?').get(queueId);
        if (item && item.attempts >= SYNC_MAX_RETRIES) {
            logger.error(`[Sync] ${queueId} exceeded max retries (${SYNC_MAX_RETRIES}), giving up`);
        }
    } catch (err) {
        logger.error(`[Sync] Failed to mark ${queueId} as failed`, err);
    }
}

// ---------------------------------------------------------------------------
// Sync stats
// ---------------------------------------------------------------------------

function getSyncStats() {
    try {
        const sqliteDb = db.getDb();
        const pending = sqliteDb.prepare("SELECT COUNT(*) as cnt FROM sync_queue WHERE sync_status = 'pending'").get().cnt;
        const failed = sqliteDb.prepare("SELECT COUNT(*) as cnt FROM sync_queue WHERE sync_status = 'failed'").get().cnt;
        const synced = sqliteDb.prepare("SELECT COUNT(*) as cnt FROM sync_queue WHERE sync_status = 'synced'").get().cnt;
        const lastSynced = sqliteDb.prepare("SELECT MAX(synced_at) as ts FROM sync_queue WHERE sync_status = 'synced'").get().ts;

        return {
            pending: Number(pending),
            failed: Number(failed),
            synced: Number(synced),
            last_synced_at: lastSynced ? Number(lastSynced) : null
        };
    } catch (err) {
        logger.error('[Sync] Failed to get stats', err);
        return { pending: 0, failed: 0, synced: 0, last_synced_at: null };
    }
}

// ---------------------------------------------------------------------------
// Upload: send pending items to HQ
// ---------------------------------------------------------------------------

/**
 * Upload all pending sync_queue items to the HQ server.
 * In the current single-server setup, this is a no-op (data is already local).
 * When a HQ URL is configured, it will POST to HQ_SYNC_URL/api/v1/sync/receive.
 *
 * @param {string} hqUrl - HQ server base URL (optional)
 * @returns {Object} { uploaded: number, failed: number }
 */
async function uploadToHQ(hqUrl) {
    if (!hqUrl) {
        // No HQ configured — mark all pending as synced (local-only mode)
        const items = getPendingItems(SYNC_BATCH_SIZE);
        for (const item of items) {
            markSynced(item.id);
        }
        return { uploaded: items.length, failed: 0 };
    }

    const items = getPendingItems(SYNC_BATCH_SIZE);
    if (items.length === 0) {
        return { uploaded: 0, failed: 0 };
    }

    let uploaded = 0;
    let failed = 0;

    for (const item of items) {
        try {
            const payload = JSON.parse(item.payload || '{}');
            const response = await fetch(`${hqUrl}/api/v1/sync/receive`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    queue_id: item.id,
                    merchant_id: item.merchant_id,
                    store_id: item.store_id,
                    entity_type: item.entity_type,
                    entity_id: item.entity_id,
                    operation: item.operation,
                    payload,
                    client_timestamp: item.created_at
                })
            });

            if (response.ok) {
                markSynced(item.id);
                uploaded++;
            } else {
                markFailed(item.id, `HTTP ${response.status}`);
                failed++;
            }
        } catch (err) {
            markFailed(item.id, err.message);
            failed++;
        }
    }

    return { uploaded, failed };
}

// ---------------------------------------------------------------------------
// Download: pull master data from HQ
// ---------------------------------------------------------------------------

/**
 * Pull master data (products, prices, users) from HQ.
 * In local-only mode, this is a no-op.
 *
 * @param {string} hqUrl - HQ server base URL (optional)
 * @param {string} merchantId
 * @param {string} storeId
 * @returns {Object} { products: number, prices: number, users: number }
 */
async function downloadFromHQ(hqUrl, merchantId, storeId) {
    const result = { products: 0, prices: 0, users: 0 };

    if (!hqUrl || !merchantId) {
        return result;
    }

    try {
        // Pull products updated after our last sync
        const stats = getSyncStats();
        const since = stats.last_synced_at || 0;

        // 1. Pull products
        const prodResp = await fetch(
            `${hqUrl}/api/v1/sync/products?merchant_id=${merchantId}&since=${since}`
        );
        if (prodResp.ok) {
            const { data: products } = await prodResp.json();
            if (Array.isArray(products)) {
                for (const p of products) {
                    await db.saveProduct(p, merchantId);
                }
                result.products = products.length;
            }
        }

        // 2. Pull store prices
        if (storeId) {
            const priceResp = await fetch(
                `${hqUrl}/api/v1/sync/prices?merchant_id=${merchantId}&store_id=${storeId}&since=${since}`
            );
            if (priceResp.ok) {
                const { data: prices } = await priceResp.json();
                if (Array.isArray(prices)) {
                    for (const sp of prices) {
                        await db.saveStorePrice(sp, merchantId);
                    }
                    result.prices = prices.length;
                }
            }
        }

        // 3. Pull users/roles
        const userResp = await fetch(
            `${hqUrl}/api/v1/sync/users?merchant_id=${merchantId}&since=${since}`
        );
        if (userResp.ok) {
            const { data: users } = await userResp.json();
            if (Array.isArray(users)) {
                for (const u of users) {
                    await db.saveUser(u, merchantId);
                }
                result.users = users.length;
            }
        }

        logger.info(`[Sync] Downloaded from HQ: ${result.products} products, ${result.prices} prices, ${result.users} users`);
    } catch (err) {
        logger.error('[Sync] Failed to download from HQ', err);
    }

    return result;
}

// ---------------------------------------------------------------------------
// Background sync loop
// ---------------------------------------------------------------------------

/**
 * Start the background sync timer.
 * @param {Object} opts
 * @param {string} opts.hqUrl - HQ server URL (optional, for multi-store mode)
 * @param {string} opts.merchantId
 * @param {string} opts.storeId
 */
function startSyncLoop(opts = {}) {
    const { hqUrl, merchantId, storeId } = opts;

    if (syncTimer) {
        clearInterval(syncTimer);
    }

    logger.info(`[Sync] Starting sync loop (interval: ${SYNC_INTERVAL_MS}ms, HQ: ${hqUrl || 'local-only'})`);

    syncTimer = setInterval(async () => {
        if (isSyncing) return; // Prevent overlapping syncs
        isSyncing = true;

        try {
            // 1. Upload pending items to HQ
            const uploadResult = await uploadToHQ(hqUrl);
            if (uploadResult.uploaded > 0 || uploadResult.failed > 0) {
                logger.info(`[Sync] Upload: ${uploadResult.uploaded} synced, ${uploadResult.failed} failed`);
            }

            // 2. Download master data from HQ (less frequent)
            // Only download if we have an HQ URL and merchant ID
            if (hqUrl && merchantId) {
                const downloadResult = await downloadFromHQ(hqUrl, merchantId, storeId);
                if (downloadResult.products > 0 || downloadResult.users > 0) {
                    logger.info(`[Sync] Download: ${downloadResult.products} products, ${downloadResult.users} users`);
                }
            }
        } catch (err) {
            logger.error('[Sync] Sync loop error', err);
        } finally {
            isSyncing = false;
        }
    }, SYNC_INTERVAL_MS);

    // Do an immediate sync on start
    setTimeout(async () => {
        if (!isSyncing) {
            isSyncing = true;
            try {
                await uploadToHQ(hqUrl);
            } catch (err) {
                logger.error('[Sync] Initial sync failed', err);
            } finally {
                isSyncing = false;
            }
        }
    }, 2000);
}

/**
 * Stop the background sync timer.
 */
function stopSyncLoop() {
    if (syncTimer) {
        clearInterval(syncTimer);
        syncTimer = null;
        logger.info('[Sync] Sync loop stopped');
    }
}

/**
 * Check if sync loop is running.
 */
function isSyncRunning() {
    return syncTimer !== null;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = {
    enqueue,
    enqueueMany,
    getPendingItems,
    markSynced,
    markFailed,
    getSyncStats,
    uploadToHQ,
    downloadFromHQ,
    startSyncLoop,
    stopSyncLoop,
    isSyncRunning
};
