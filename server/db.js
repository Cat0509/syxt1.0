/**
 * Ruyi POS - SQLite Data Access Layer
 *
 * Replaces mysql2/promise with better-sqlite3.
 * All public methods remain async (return Promises) so that route files
 * that use await continue to work without changes.
 *
 * better-sqlite3 is synchronous under the hood; we wrap calls in
 * Promise.resolve() where a scalar/array is returned, and keep native
 * Promise chains for methods that already use async/await internally.
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { generateId, generateOrderNo } = require('./id_utils');

// ---------------------------------------------------------------------------
// Database path resolution
// ---------------------------------------------------------------------------
function resolveDbPath() {
    // 1. Explicit env override (useful in dev)
    if (process.env.DB_PATH) {
        return process.env.DB_PATH;
    }
    // 2. Electron userData directory
    try {
        // When running inside Electron, app.getPath is available
        const { app } = require('electron');
        if (app && app.getPath) {
            const dir = path.join(app.getPath('userData'), 'RuyiPOS');
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            return path.join(dir, 'data.db');
        }
    } catch (_) {
        // Not in Electron – fall through
    }
    // 3. Dev fallback: project-local file
    return path.join(__dirname, 'data.db');
}

// ---------------------------------------------------------------------------
// Singleton connection
// ---------------------------------------------------------------------------
let db = null;

function getDb() {
    if (!db) {
        throw new Error('Database not initialized. Call db.init() first.');
    }
    return db;
}

// ---------------------------------------------------------------------------
// Mock connection object for route-level transactions
// ---------------------------------------------------------------------------
function createMockConnection(sqliteDb) {
    return {
        _db: sqliteDb,
        _inTransaction: false,

        async beginTransaction() {
            sqliteDb.exec('BEGIN IMMEDIATE');
            this._inTransaction = true;
        },

        async commit() {
            sqliteDb.exec('COMMIT');
            this._inTransaction = false;
        },

        async rollback() {
            sqliteDb.exec('ROLLBACK');
            this._inTransaction = false;
        },

        /**
         * Mimics mysql2's conn.execute(sql, params) which returns [rows, fields].
         * better-sqlite3 returns rows directly for SELECT, and changes info for
         * INSERT/UPDATE/DELETE.  We always return [rows] to match mysql2 usage
         * pattern: const [rows] = await conn.execute(sql, params);
         */
        async execute(sql, params = []) {
            const stmt = sqliteDb.prepare(sql);
            const isSelect = /^\s*SELECT\b/i.test(sql);

            if (isSelect) {
                const rows = stmt.all(...params);
                return [rows, undefined];
            }

            // INSERT / UPDATE / DELETE
            const result = stmt.run(...params);
            return [{ affectedRows: result.changes, insertId: result.lastInsertRowid }, undefined];
        },

        release() {
            // No-op for SQLite (single connection)
        }
    };
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------
function init() {
    if (db) {
        return db;
    }

    const dbPath = resolveDbPath();
    console.log(`[DB] Opening SQLite database: ${dbPath}`);

    db = new Database(dbPath);

    // Performance & safety pragmas
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('busy_timeout = 5000');
    db.pragma('foreign_keys = ON');

    // Run schema if tables don't exist yet
    const tableCount = db.prepare(
        "SELECT COUNT(*) AS cnt FROM sqlite_master WHERE type='table'"
    ).get().cnt;

    if (tableCount === 0) {
        console.log('[DB] Empty database – running schema …');
        const schemaPath = path.join(__dirname, 'sqlite_schema.sql');
        const schema = fs.readFileSync(schemaPath, 'utf-8');
        db.exec(schema);
        console.log('[DB] Schema applied successfully.');
    }

    return db;
}

function close() {
    if (db) {
        db.close();
        db = null;
    }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns a mock connection that supports beginTransaction/commit/rollback/execute.
 * Used by route files that do manual transaction management.
 */
function getConnection() {
    return Promise.resolve(createMockConnection(getDb()));
}

/**
 * Raw query helper – mirrors old pool.execute().
 * Returns [rows, fields] so callers can destructure as before.
 */
function query(sql, params = []) {
    const sqliteDb = getDb();
    const isSelect = /^\s*SELECT\b/i.test(sql);

    if (isSelect) {
        const rows = sqliteDb.prepare(sql).all(...params);
        return Promise.resolve([rows, undefined]);
    }

    const result = sqliteDb.prepare(sql).run(...params);
    return Promise.resolve([{ affectedRows: result.changes, insertId: result.lastInsertRowid }, undefined]);
}

/**
 * Execute a callback inside a transaction.
 * The callback receives a mock connection with beginTransaction/commit/rollback/execute.
 */
async function withTransaction(callback) {
    const sqliteDb = getDb();
    sqliteDb.exec('BEGIN IMMEDIATE');
    const conn = createMockConnection(sqliteDb);
    conn._inTransaction = true;
    try {
        const result = await callback(conn);
        sqliteDb.exec('COMMIT');
        conn._inTransaction = false;
        return result;
    } catch (err) {
        sqliteDb.exec('ROLLBACK');
        conn._inTransaction = false;
        throw err;
    }
}

// ===========================================================================
// Store operations
// ===========================================================================
async function getStoreList(merchantId) {
    const rows = getDb().prepare(
        'SELECT * FROM stores WHERE merchant_id = ? ORDER BY created_at ASC'
    ).all(merchantId);
    return rows;
}

async function saveStore(store, merchantId) {
    const { id, name } = store;
    const sid = id || generateId();
    getDb().prepare(
        `INSERT INTO stores (id, merchant_id, name, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name`
    ).run(sid, merchantId, name, Date.now());
    return { ...store, id: sid, merchant_id: merchantId };
}

// ===========================================================================
// Merchant operations
// ===========================================================================
async function getMerchantCount() {
    const row = getDb().prepare('SELECT COUNT(*) as count FROM merchants').get();
    return row.count;
}

async function saveMerchant(merchant) {
    const { id, name, contact_phone, status } = merchant;
    const mid = id || generateId();
    getDb().prepare(
        `INSERT INTO merchants (id, name, contact_phone, status, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name,
             contact_phone = excluded.contact_phone,
             status = excluded.status`
    ).run(mid, name, contact_phone || '', status || 'active', Date.now());
    return { ...merchant, id: mid };
}

// ===========================================================================
// Product operations
// ===========================================================================
async function getProducts(merchantId, storeId) {
    const sqliteDb = getDb();
    let productSql;
    let productParams;

    if (storeId) {
        productSql = `
            SELECT p.*,
                   COALESCE(sp.price, p.price) AS price,
                   COALESCE(i.stock, 0) AS current_stock
            FROM products p
            LEFT JOIN inventory i
                ON i.merchant_id = p.merchant_id
                AND i.product_id = p.id
                AND i.sku_id = ''
                AND i.store_id = ?
            LEFT JOIN store_prices sp
                ON sp.store_id = ?
                AND sp.product_id = p.id
                AND sp.sku_id = ''
            WHERE p.merchant_id = ?
            ORDER BY p.updated_at DESC
        `;
        productParams = [storeId, storeId, merchantId];
    } else {
        productSql = `
            SELECT p.*, COALESCE(inv.total_stock, 0) AS current_stock
            FROM products p
            LEFT JOIN (
                SELECT merchant_id, product_id, SUM(stock) AS total_stock
                FROM inventory
                WHERE sku_id = ''
                GROUP BY merchant_id, product_id
            ) inv
                ON inv.merchant_id = p.merchant_id
                AND inv.product_id = p.id
            WHERE p.merchant_id = ?
            ORDER BY p.updated_at DESC
        `;
        productParams = [merchantId];
    }

    const rows = sqliteDb.prepare(productSql).all(...productParams);

    for (const p of rows) {
        p.stock = Number(p.current_stock || 0);
        p.store_id = storeId || null;

        let skuSql;
        let skuParams;

        if (storeId) {
            skuSql = `
                SELECT s.*,
                       COALESCE(sp.price, s.price, p.price) AS price,
                       COALESCE(i.stock, 0) AS current_stock
                FROM skus s
                JOIN products p ON s.product_id = p.id
                LEFT JOIN inventory i
                    ON i.merchant_id = s.merchant_id
                    AND i.sku_id = s.id
                    AND i.store_id = ?
                LEFT JOIN store_prices sp
                    ON sp.store_id = ?
                    AND sp.sku_id = s.id
                WHERE s.product_id = ?
            `;
            skuParams = [storeId, storeId, p.id];
        } else {
            skuSql = `
                SELECT s.*, COALESCE(inv.total_stock, 0) AS current_stock
                FROM skus s
                LEFT JOIN (
                    SELECT merchant_id, sku_id, SUM(stock) AS total_stock
                    FROM inventory
                    WHERE sku_id <> ''
                    GROUP BY merchant_id, sku_id
                ) inv
                    ON inv.merchant_id = s.merchant_id
                    AND inv.sku_id = s.id
                WHERE s.product_id = ?
            `;
            skuParams = [p.id];
        }

        const skus = sqliteDb.prepare(skuSql).all(...skuParams);
        p.skus = skus.map((s) => ({
            ...s,
            stock: Number(s.current_stock || 0),
            store_id: storeId || null
        }));
    }

    return rows;
}

async function saveProduct(p, merchantId) {
    const { id, name, price, category, barcode, stock, store_id, skus } = p;
    const pid = id || generateId();
    const now = Date.now();
    const baseStock = Number.isFinite(Number(stock)) ? Number(stock) : 0;
    const sqliteDb = getDb();

    // 1. Save to products table
    sqliteDb.prepare(
        `INSERT INTO products (id, merchant_id, name, price, category, barcode, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name,
             price = excluded.price,
             category = excluded.category,
             barcode = excluded.barcode,
             updated_at = excluded.updated_at`
    ).run(pid, merchantId, name, price, category, barcode, now);

    // 2. Initialize inventory rows for new products only
    if (store_id) {
        sqliteDb.prepare(
            `INSERT INTO inventory (id, merchant_id, store_id, product_id, sku_id, stock, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at`
        ).run(`inv_p_${pid}_${store_id}`, merchantId, store_id, pid, '', baseStock, now);
    }

    if (skus && skus.length > 0) {
        for (const s of skus) {
            const sid = s.id || generateId();
            const skuStock = Number.isFinite(Number(s.stock)) ? Number(s.stock) : 0;

            sqliteDb.prepare(
                `INSERT INTO skus (id, merchant_id, product_id, specName, price, barcode)
                 VALUES (?, ?, ?, ?, ?, ?)
                 ON CONFLICT(id) DO UPDATE SET specName = excluded.specName,
                     price = excluded.price,
                     barcode = excluded.barcode`
            ).run(sid, merchantId, pid, s.specName, s.price, s.barcode);

            // Initialize SKU inventory rows for new SKUs only
            if (store_id) {
                sqliteDb.prepare(
                    `INSERT INTO inventory (id, merchant_id, store_id, product_id, sku_id, stock, updated_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?)
                     ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at`
                ).run(`inv_s_${sid}_${store_id}`, merchantId, store_id, pid, sid, skuStock, now);
            }
        }
    }
}

async function deleteProduct(productId, merchantId) {
    const sqliteDb = getDb();
    sqliteDb.exec('BEGIN IMMEDIATE');
    try {
        sqliteDb.prepare(
            'DELETE FROM inventory WHERE merchant_id = ? AND product_id = ?'
        ).run(merchantId, productId);

        sqliteDb.prepare(
            'DELETE FROM skus WHERE merchant_id = ? AND product_id = ?'
        ).run(merchantId, productId);

        sqliteDb.prepare(
            'DELETE FROM products WHERE merchant_id = ? AND id = ?'
        ).run(merchantId, productId);

        sqliteDb.exec('COMMIT');
        return true;
    } catch (err) {
        sqliteDb.exec('ROLLBACK');
        throw err;
    }
}

// ===========================================================================
// Inventory operations
// ===========================================================================
async function updateInventoryStock(merchantId, storeId, productId, skuId, qtyChange) {
    const sku = skuId || '';
    const now = Date.now();
    getDb().prepare(
        `INSERT INTO inventory (id, merchant_id, store_id, product_id, sku_id, stock, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET stock = stock + excluded.stock,
             updated_at = excluded.updated_at`
    ).run(`inv_${sku || productId}_${storeId}`, merchantId, storeId, productId, sku, qtyChange, now);
}

// ===========================================================================
// Transaction (order) operations
// ===========================================================================
async function getTransactions(merchantId, filters = {}) {
    const { storeId, startTime, endTime, status, orderId, paymentStatus, clientTxId } = filters;
    let sql = 'SELECT * FROM transactions WHERE merchant_id = ?';
    let params = [merchantId];

    if (storeId) { sql += ' AND store_id = ?'; params.push(storeId); }
    if (orderId) { sql += ' AND id = ?'; params.push(orderId); }
    if (clientTxId) { sql += ' AND client_tx_id = ?'; params.push(clientTxId); }
    if (startTime) { sql += ' AND time >= ?'; params.push(startTime); }
    if (endTime) { sql += ' AND time <= ?'; params.push(endTime); }
    if (status) { sql += ' AND status = ?'; params.push(status); }
    if (paymentStatus) { sql += ' AND payment_status = ?'; params.push(paymentStatus); }

    sql += ' ORDER BY time DESC';
    const rows = getDb().prepare(sql).all(...params);

    const txs = rows.map((tx) => {
        const items = getDb().prepare('SELECT * FROM order_items WHERE order_id = ?').all(tx.id);
        const payments = getDb().prepare('SELECT * FROM order_payments WHERE order_id = ?').all(tx.id);

        return {
            ...tx,
            payment: typeof tx.payment === 'string' ? JSON.parse(tx.payment || '{}') : tx.payment,
            items,
            payments
        };
    });

    return txs;
}

async function saveTransaction(tx, merchantId) {
    const { id, time, items, total, amount, payment, processed_by, store_id, order_no, status, payment_status, payment_method, cashier_id, client_tx_id, device_id } = tx;
    const tid = id || generateId();
    const ono = order_no || generateOrderNo(store_id);
    const sqliteDb = getDb();

    // 1. Save to transactions
    sqliteDb.prepare(
        `INSERT INTO transactions (
            id, merchant_id, time, items, total, amount, payment, processed_by, store_id, updated_at,
            order_no, status, payment_status, payment_method, cashier_id, client_tx_id, device_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            time = excluded.time, items = excluded.items, total = excluded.total,
            amount = excluded.amount, payment = excluded.payment,
            processed_by = excluded.processed_by, store_id = excluded.store_id,
            updated_at = excluded.updated_at, status = excluded.status,
            payment_status = excluded.payment_status, payment_method = excluded.payment_method,
            device_id = excluded.device_id`
    ).run(
        tid, merchantId, time || Date.now(), '[]', total || 0, amount || 0,
        JSON.stringify(payment || {}), processed_by || '', store_id || null, Date.now(),
        ono, status || 'pending', payment_status || 'unpaid', payment_method || 'cash',
        cashier_id || null, client_tx_id || null, device_id || null
    );

    // 2. Save items to order_items table
    if (items && items.length > 0) {
        for (const item of items) {
            const oiid = item.id || generateId();
            sqliteDb.prepare(
                `INSERT INTO order_items (id, order_id, product_id, sku_id, name, price, qty, subtotal)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(id) DO UPDATE SET price = excluded.price,
                     qty = excluded.qty, subtotal = excluded.subtotal`
            ).run(
                oiid, tid, item.product_id || item.id, item.sku_id || '',
                item.name, item.price, item.qty, item.subtotal
            );
        }
    }

    return { ...tx, id: tid, order_no: ono };
}

// ===========================================================================
// Payment operations
// ===========================================================================
async function saveOrderPayment(payment, merchantId) {
    const { id, store_id, order_id, method, amount, status, transaction_ref } = payment;
    const pid = id || generateId();
    getDb().prepare(
        `INSERT INTO order_payments (id, merchant_id, store_id, order_id, method, amount, status, transaction_ref, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET status = excluded.status,
             transaction_ref = excluded.transaction_ref`
    ).run(pid, merchantId, store_id, order_id, method, amount, status || 'success', transaction_ref || null, Date.now());
    return { ...payment, id: pid };
}

async function getOrderPayments(orderId) {
    return getDb().prepare('SELECT * FROM order_payments WHERE order_id = ?').all(orderId);
}

async function saveStorePrice(priceData, merchantId) {
    const { store_id, product_id, sku_id, price } = priceData;
    const id = generateId();
    getDb().prepare(
        `INSERT INTO store_prices (id, merchant_id, store_id, product_id, sku_id, price, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET price = excluded.price,
             updated_at = excluded.updated_at`
    ).run(id, merchantId, store_id, product_id, sku_id || '', price, Date.now());
}

// ===========================================================================
// User operations
// ===========================================================================
async function getUsers(merchantId, storeId) {
    let sql = 'SELECT * FROM users WHERE merchant_id = ?';
    let params = [merchantId];
    if (storeId) { sql += ' AND store_id = ?'; params.push(storeId); }
    return getDb().prepare(sql).all(...params);
}

async function getUserByUsername(username, merchantId) {
    let sql = 'SELECT * FROM users WHERE username = ?';
    let params = [username];
    if (merchantId) { sql += ' AND merchant_id = ?'; params.push(merchantId); }
    return getDb().prepare(sql).get(...params) || undefined;
}

async function getUserById(id, merchantId) {
    return getDb().prepare('SELECT * FROM users WHERE id = ? AND merchant_id = ?').get(id, merchantId) || undefined;
}

async function saveUser(user, merchantId) {
    const { id, username, password, password_hash, name, role, store_id, status } = user;
    const uid = id || generateId();
    const userStatus = status || 'active';
    getDb().prepare(
        `INSERT INTO users (id, merchant_id, username, password, password_hash, name, role, store_id, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name,
             role = excluded.role, store_id = excluded.store_id,
             status = excluded.status, updated_at = excluded.updated_at`
    ).run(uid, merchantId, username, password || null, password_hash || null, name, role, store_id || null, userStatus, Date.now(), Date.now());
    return { ...user, id: uid, merchant_id: merchantId, status: userStatus };
}

async function updateUserPassword(id, merchantId, passwordHash) {
    getDb().prepare(
        'UPDATE users SET password_hash = ?, password = NULL, updated_at = ? WHERE id = ? AND merchant_id = ?'
    ).run(passwordHash, Date.now(), id, merchantId);
}

async function updateUserStatus(id, merchant_id, status) {
    getDb().prepare(
        'UPDATE users SET status = ?, updated_at = ? WHERE id = ? AND merchant_id = ?'
    ).run(status, Date.now(), id, merchant_id);
}

async function updateLastLogin(id, merchantId) {
    if (merchantId) {
        getDb().prepare('UPDATE users SET last_login_at = ? WHERE id = ? AND merchant_id = ?').run(Date.now(), id, merchantId);
    } else {
        getDb().prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(Date.now(), id);
    }
}

// ===========================================================================
// Audit log operations
// ===========================================================================
async function getAuditLogs(merchantId, filters = {}) {
    const { storeId, action, startTime, endTime, userId, username, limit = 500 } = filters;
    let sql = 'SELECT * FROM audit_logs WHERE merchant_id = ?';
    let params = [merchantId];

    if (storeId) { sql += ' AND store_id = ?'; params.push(storeId); }
    if (action) { sql += ' AND action = ?'; params.push(action); }
    if (startTime) { sql += ' AND time >= ?'; params.push(startTime); }
    if (endTime) { sql += ' AND time <= ?'; params.push(endTime); }
    if (userId) { sql += ' AND user_id = ?'; params.push(userId); }
    if (username) { sql += ' AND username LIKE ?'; params.push(`%${username}%`); }

    sql += ' ORDER BY time DESC LIMIT ?';
    params.push(Number.parseInt(limit, 10) || 500);

    return getDb().prepare(sql).all(...params);
}

async function saveAuditLog(log, merchantId) {
    const { action, details, store_id, user_id, username } = log;
    const logId = getDb().prepare(
        'INSERT INTO audit_logs (merchant_id, action, details, time, store_id, user_id, username) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(merchantId, action, JSON.stringify(details), Date.now(), store_id || null, user_id || null, username || null);

    // Enqueue audit log for sync (fire-and-forget)
    try {
        const syncService = require('./sync_service');
        syncService.enqueue({
            merchant_id: merchantId,
            store_id,
            entity_type: 'audit_log',
            entity_id: logId.lastInsertRowid.toString(),
            operation: 'create',
            payload: { action, details, user_id, username, store_id }
        });
    } catch (_) {
        // Don't let sync enqueue failure break audit logging
    }
}

// ===========================================================================
// Device operations
// ===========================================================================
async function getDeviceById(deviceId) {
    return getDb().prepare('SELECT * FROM devices WHERE id = ?').get(deviceId) || undefined;
}

async function saveDevice(device) {
    const { id, name, store_id, status } = device;
    getDb().prepare(
        `INSERT INTO devices (id, name, store_id, status, created_at, last_login_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name,
             store_id = excluded.store_id, status = excluded.status,
             last_login_at = excluded.last_login_at`
    ).run(id, name, store_id || null, status || 'active', Date.now(), Date.now());
    return device;
}

// ===========================================================================
// Exports
// ===========================================================================
module.exports = {
    init,
    close,
    getDb,
    getDbPath: resolveDbPath,
    getConnection,
    query,
    withTransaction,
    getStoreList,
    saveStore,
    getMerchantCount,
    saveMerchant,
    getProducts,
    saveProduct,
    deleteProduct,
    updateInventoryStock,
    getTransactions,
    saveTransaction,
    saveOrderPayment,
    getOrderPayments,
    saveStorePrice,
    getUsers,
    getUserByUsername,
    getUserById,
    saveUser,
    updateUserPassword,
    updateUserStatus,
    updateLastLogin,
    getAuditLogs,
    saveAuditLog,
    getDeviceById,
    saveDevice
};
