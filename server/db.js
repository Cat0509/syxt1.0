const mysql = require('mysql2/promise');
const { generateId, generateOrderNo } = require('./id_utils');

const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'ruyi_pos',
    port: process.env.DB_PORT || 3306,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

module.exports = {
    getConnection: () => pool.getConnection(),
    query: (sql, params) => pool.execute(sql, params),

    /**
     * Helper to execute database operations within a transaction.
     * @param {Function} callback - Async function that receives the connection.
     * @returns {Promise<any>}
     */
    withTransaction: async (callback) => {
        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();
            const result = await callback(conn);
            await conn.commit();
            return result;
        } catch (err) {
            await conn.rollback();
            throw err;
        } finally {
            conn.release();
        }
    },

    getStoreList: async (merchantId) => {
        const [rows] = await pool.execute('SELECT * FROM stores WHERE merchant_id = ? ORDER BY created_at ASC', [merchantId]);
        return rows;
    },
    saveStore: async (store, merchantId) => {
        const { id, name } = store;
        const sid = id || generateId();
        await pool.execute(
            'INSERT INTO stores (id, merchant_id, name, created_at) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE name=?',
            [sid, merchantId, name, Date.now(), name]
        );
        return { ...store, id: sid, merchant_id: merchantId };
    },

    // 商户操作
    getMerchantCount: async () => {
        const [rows] = await pool.execute('SELECT COUNT(*) as count FROM merchants');
        return rows[0].count;
    },
    saveMerchant: async (merchant) => {
        const { id, name, contact_phone, status } = merchant;
        const mid = id || generateId();
        await pool.execute(
            'INSERT INTO merchants (id, name, contact_phone, status, created_at) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE name=?, contact_phone=?, status=?',
            [mid, name, contact_phone || '', status || 'active', Date.now(), name, contact_phone || '', status || 'active']
        );
        return { ...merchant, id: mid };
    },

    // 商品操作
    getProducts: async (merchantId, storeId) => {
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

        const [rows] = await pool.execute(productSql, productParams);

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

            const [skus] = await pool.execute(skuSql, skuParams);
            p.skus = skus.map((s) => ({
                ...s,
                stock: Number(s.current_stock || 0),
                store_id: storeId || null
            }));
        }

        return rows;
    },
    saveProduct: async (p, merchantId) => {
        const { id, name, price, category, barcode, stock, store_id, skus } = p;
        const pid = id || generateId();
        const now = Date.now();
        const baseStock = Number.isFinite(Number(stock)) ? Number(stock) : 0;

        // 1. Save to products table (stock and store_id columns are deprecated)
        await pool.execute(
            'INSERT INTO products (id, merchant_id, name, price, category, barcode, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE name=?, price=?, category=?, barcode=?, updated_at=?',
            [pid, merchantId, name, price, category, barcode, now, name, price, category, barcode, now]
        );
        
        // 2. Initialize inventory rows for new products only.
        // Inventory changes after creation should go through /inventory/adjust or order/refund flows.
        if (store_id) {
            await pool.execute(
                'INSERT INTO inventory (id, merchant_id, store_id, product_id, sku_id, stock, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE updated_at = VALUES(updated_at)',
                [`inv_p_${pid}_${store_id}`, merchantId, store_id, pid, '', baseStock, now]
            );
        }

        if (skus && skus.length > 0) {
            for (let s of skus) {
                const sid = s.id || generateId();
                const skuStock = Number.isFinite(Number(s.stock)) ? Number(s.stock) : 0;
                await pool.execute(
                    'INSERT INTO skus (id, merchant_id, product_id, specName, price, barcode) VALUES (?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE specName=?, price=?, barcode=?',
                    [sid, merchantId, pid, s.specName, s.price, s.barcode, s.specName, s.price, s.barcode]
                );
                
                // Initialize SKU inventory rows for new SKUs only.
                if (store_id) {
                    await pool.execute(
                        'INSERT INTO inventory (id, merchant_id, store_id, product_id, sku_id, stock, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE updated_at = VALUES(updated_at)',
                        [`inv_s_${sid}_${store_id}`, merchantId, store_id, pid, sid, skuStock, now]
                    );
                }
            }
        }
    },

    deleteProduct: async (productId, merchantId) => {
        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();

            // 1. Delete from inventory
            await conn.execute(
                'DELETE FROM inventory WHERE merchant_id = ? AND product_id = ?',
                [merchantId, productId]
            );

            // 2. Delete from skus
            await conn.execute(
                'DELETE FROM skus WHERE merchant_id = ? AND product_id = ?',
                [merchantId, productId]
            );

            // 3. Delete from products
            await conn.execute(
                'DELETE FROM products WHERE merchant_id = ? AND id = ?',
                [merchantId, productId]
            );

            await conn.commit();
            return true;
        } catch (err) {
            await conn.rollback();
            throw err;
        } finally {
            conn.release();
        }
    },

    // 库存操作 (Phase 3 New)
    updateInventoryStock: async (merchantId, storeId, productId, skuId, qtyChange) => {
        const sku = skuId || '';
        await pool.execute(
            'INSERT INTO inventory (id, merchant_id, store_id, product_id, sku_id, stock, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE stock = stock + ?, updated_at = ?',
            [`inv_${sku || productId}_${storeId}`, merchantId, storeId, productId, sku, qtyChange, Date.now(), qtyChange, Date.now()]
        );
    },

    // 交易操作
    getTransactions: async (merchantId, filters = {}) => {
        const { storeId, startTime, endTime, status, orderId, paymentStatus, clientTxId } = filters;
        let sql = 'SELECT * FROM transactions WHERE merchant_id = ?';
        let params = [merchantId];
        
        if (storeId) {
            sql += ' AND store_id = ?';
            params.push(storeId);
        }
        if (orderId) {
            sql += ' AND id = ?';
            params.push(orderId);
        }
        if (clientTxId) {
            sql += ' AND client_tx_id = ?';
            params.push(clientTxId);
        }
        if (startTime) {
            sql += ' AND time >= ?';
            params.push(startTime);
        }
        if (endTime) {
            sql += ' AND time <= ?';
            params.push(endTime);
        }
        if (status) {
            sql += ' AND status = ?';
            params.push(status);
        }
        if (paymentStatus) {
            sql += ' AND payment_status = ?';
            params.push(paymentStatus);
        }

        sql += ' ORDER BY time DESC';
        const [rows] = await pool.execute(sql, params);
        
        // Map transactions and load items and payments
        const txs = await Promise.all(rows.map(async (tx) => {
            const [items] = await pool.execute('SELECT * FROM order_items WHERE order_id = ?', [tx.id]);
            const [payments] = await pool.execute('SELECT * FROM order_payments WHERE order_id = ?', [tx.id]);
            
            return {
                ...tx,
                payment: typeof tx.payment === 'string' ? JSON.parse(tx.payment || '{}') : tx.payment,
                items,
                payments
            };
        }));

        return txs;
    },
    saveTransaction: async (tx, merchantId) => {
        const { id, time, items, total, amount, payment, processed_by, store_id, order_no, status, payment_status, payment_method, cashier_id, client_tx_id, device_id } = tx;
        const tid = id || generateId();
        const ono = order_no || generateOrderNo(store_id);

        // 1. Save to transactions (items JSON column is now deprecated - write empty array for safety/compatibility)
        await pool.execute(
            `INSERT INTO transactions (
                id, merchant_id, time, items, total, amount, payment, processed_by, store_id, updated_at, 
                order_no, status, payment_status, payment_method, cashier_id, client_tx_id, device_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) 
            ON DUPLICATE KEY UPDATE 
                time=VALUES(time), items=VALUES(items), total=VALUES(total), amount=VALUES(amount), 
                payment=VALUES(payment), processed_by=VALUES(processed_by), store_id=VALUES(store_id), 
                updated_at=VALUES(updated_at), status=VALUES(status), payment_status=VALUES(payment_status),
                payment_method=VALUES(payment_method), device_id=VALUES(device_id)`,
            [
                tid, merchantId, time || Date.now(), '[]', total || 0, amount || 0, 
                JSON.stringify(payment || {}), processed_by || '', store_id || null, Date.now(),
                ono, status || 'pending', payment_status || 'unpaid', payment_method || 'cash', 
                cashier_id || null, client_tx_id || null, device_id || null
            ]
        );

        // 2. Save items to order_items table
        if (items && items.length > 0) {
            for (let item of items) {
                const oiid = item.id || generateId();
                await pool.execute(
                    `INSERT INTO order_items (id, order_id, product_id, sku_id, name, price, qty, subtotal) 
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?) 
                     ON DUPLICATE KEY UPDATE price=VALUES(price), qty=VALUES(qty), subtotal=VALUES(subtotal)`,
                    [
                        oiid, tid, item.product_id || item.id, item.sku_id || '', 
                        item.name, item.price, item.qty, item.subtotal
                    ]
                );
            }
        }
        
        return { ...tx, id: tid, order_no: ono };
    },

    // 支付操作 (Phase 5 New)
    saveOrderPayment: async (payment, merchantId) => {
        const { id, store_id, order_id, method, amount, status, transaction_ref } = payment;
        const pid = id || generateId();
        await pool.execute(
            `INSERT INTO order_payments (id, merchant_id, store_id, order_id, method, amount, status, transaction_ref, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE status=VALUES(status), transaction_ref=VALUES(transaction_ref)`,
            [pid, merchantId, store_id, order_id, method, amount, status || 'success', transaction_ref || null, Date.now()]
        );
        return { ...payment, id: pid };
    },
    getOrderPayments: async (orderId) => {
        const [rows] = await pool.execute('SELECT * FROM order_payments WHERE order_id = ?', [orderId]);
        return rows;
    },

    saveStorePrice: async (priceData, merchantId) => {
        const { store_id, product_id, sku_id, price } = priceData;
        const id = generateId();
        await pool.execute(
            `INSERT INTO store_prices (id, merchant_id, store_id, product_id, sku_id, price, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE price=VALUES(price), updated_at=VALUES(updated_at)`,
            [id, merchantId, store_id, product_id, sku_id || '', price, Date.now()]
        );
    },

    // 用户操作
    getUsers: async (merchantId, storeId) => {
        let sql = 'SELECT * FROM users WHERE merchant_id = ?';
        let params = [merchantId];
        if (storeId) {
            sql += ' AND store_id = ?';
            params.push(storeId);
        }
        const [rows] = await pool.execute(sql, params);
        return rows;
    },
    getUserByUsername: async (username, merchantId) => {
        let sql = 'SELECT * FROM users WHERE username = ?';
        let params = [username];
        if (merchantId) {
            sql += ' AND merchant_id = ?';
            params.push(merchantId);
        }
        const [rows] = await pool.execute(sql, params);
        return rows[0];
    },
    getUserById: async (id, merchantId) => {
        const [rows] = await pool.execute('SELECT * FROM users WHERE id = ? AND merchant_id = ?', [id, merchantId]);
        return rows[0];
    },
    saveUser: async (user, merchantId) => {
        const { id, username, password, password_hash, name, role, store_id, status } = user;
        const uid = id || generateId();
        const userStatus = status || 'active';
        await pool.execute(
            'INSERT INTO users (id, merchant_id, username, password, password_hash, name, role, store_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE name=?, role=?, store_id=?, status=?, updated_at=?',
            [uid, merchantId, username, password || null, password_hash || null, name, role, store_id || null, userStatus, Date.now(), Date.now(), name, role, store_id || null, userStatus, Date.now()]
        );
        return { ...user, id: uid, merchant_id: merchantId, status: userStatus };
    },
    updateUserPassword: async (id, merchantId, passwordHash) => {
        await pool.execute('UPDATE users SET password_hash = ?, password = NULL, updated_at = ? WHERE id = ? AND merchant_id = ?', [passwordHash, Date.now(), id, merchantId]);
    },
    updateUserStatus: async (id, merchant_id, status) => {
        await pool.execute('UPDATE users SET status = ?, updated_at = ? WHERE id = ? AND merchant_id = ?', [status, Date.now(), id, merchant_id]);
    },
    updateLastLogin: async (id, merchantId) => {
        if (merchantId) {
            await pool.execute('UPDATE users SET last_login_at = ? WHERE id = ? AND merchant_id = ?', [Date.now(), id, merchantId]);
        } else {
            await pool.execute('UPDATE users SET last_login_at = ? WHERE id = ?', [Date.now(), id]);
        }
    },

    // 审计日志
    getAuditLogs: async (merchantId, filters = {}) => {
        const { storeId, action, startTime, endTime, userId, username, limit = 500 } = filters;
        let sql = 'SELECT * FROM audit_logs WHERE merchant_id = ?';
        let params = [merchantId];

        if (storeId) {
            sql += ' AND store_id = ?';
            params.push(storeId);
        }
        if (action) {
            sql += ' AND action = ?';
            params.push(action);
        }
        if (startTime) {
            sql += ' AND time >= ?';
            params.push(startTime);
        }
        if (endTime) {
            sql += ' AND time <= ?';
            params.push(endTime);
        }
        if (userId) {
            sql += ' AND user_id = ?';
            params.push(userId);
        }
        if (username) {
            sql += ' AND username LIKE ?';
            params.push(`%${username}%`);
        }

        sql += ' ORDER BY time DESC LIMIT ?';
        params.push(Number.parseInt(limit, 10) || 500);

        const [rows] = await pool.execute(sql, params);
        return rows;
    },
    saveAuditLog: async (log, merchantId) => {
        const { action, details, store_id, user_id, username } = log;
        await pool.execute(
            'INSERT INTO audit_logs (merchant_id, action, details, time, store_id, user_id, username) VALUES (?, ?, ?, ?, ?, ?, ?)', 
            [merchantId, action, JSON.stringify(details), Date.now(), store_id || null, user_id || null, username || null]
        );
    },

    // 设备操作
    getDeviceById: async (deviceId) => {
        const [rows] = await pool.execute('SELECT * FROM devices WHERE id = ?', [deviceId]);
        return rows[0];
    },
    saveDevice: async (device) => {
        const { id, name, store_id, status } = device;
        await pool.execute(
            'INSERT INTO devices (id, name, store_id, status, created_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE name=?, store_id=?, status=?, last_login_at=?',
            [id, name, store_id || null, status || 'active', Date.now(), Date.now(), name, store_id || null, status || 'active', Date.now()]
        );
        return device;
    }
};
