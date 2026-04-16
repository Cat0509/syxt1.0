const mysql = require('mysql2/promise');
require('dotenv').config();

const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'ruyi_pos',
    port: process.env.DB_PORT || 3306
});

async function migrate() {
    const conn = await pool.getConnection();
    console.log('Starting Phase 3 Migration...');

    try {
        // 1. Create inventory table (ensure it matches mysql_schema.sql)
        console.log('Creating inventory table if not exists...');
        await conn.execute(`
            CREATE TABLE IF NOT EXISTS inventory (
                id VARCHAR(50) PRIMARY KEY,
                merchant_id VARCHAR(50) NOT NULL,
                store_id VARCHAR(50) NOT NULL,
                product_id VARCHAR(50) NOT NULL,
                sku_id VARCHAR(50) DEFAULT '',
                stock INT DEFAULT 0,
                updated_at BIGINT,
                UNIQUE KEY uniq_store_item (store_id, product_id, sku_id),
                FOREIGN KEY (merchant_id) REFERENCES merchants(id) ON DELETE CASCADE,
                FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE
            )
        `);

        const ensureColumn = async (table, columnName, definition, backfillSql = null) => {
            const [rows] = await conn.execute(`SHOW COLUMNS FROM ${table} LIKE ?`, [columnName]);
            if (rows.length === 0) {
                console.log(`Adding column ${columnName} to ${table}...`);
                await conn.execute(`ALTER TABLE ${table} ADD COLUMN ${columnName} ${definition}`);
            }
            if (backfillSql) {
                await conn.execute(backfillSql);
            }
        };

        await ensureColumn(
            'refunds',
            'merchant_id',
            'VARCHAR(50) DEFAULT NULL AFTER id',
            `UPDATE refunds r
             JOIN transactions t ON r.order_id = t.id
             SET r.merchant_id = t.merchant_id
             WHERE r.merchant_id IS NULL OR r.merchant_id = ''`
        );

        // 2. Add reporting indexes (using a helper to avoid "duplicate index" errors)
        const addIndex = async (table, indexName, columns) => {
            try {
                const [rows] = await conn.execute(`SHOW INDEX FROM ${table} WHERE Key_name = ?`, [indexName]);
                if (rows.length === 0) {
                    console.log(`Adding index ${indexName} to ${table}...`);
                    await conn.execute(`ALTER TABLE ${table} ADD INDEX ${indexName} (${columns})`);
                } else {
                    console.log(`Index ${indexName} already exists on ${table}.`);
                }
            } catch (err) {
                console.error(`Failed to add index ${indexName}:`, err.message);
            }
        };

        await addIndex('transactions', 'idx_merchant_time', 'merchant_id, time');
        await addIndex('transactions', 'idx_store_status_time', 'store_id, status, time');
        await addIndex('transactions', 'idx_payment_time', 'payment_method, time');
        await addIndex('order_items', 'idx_product_id', 'product_id');
        await addIndex('order_items', 'idx_sku_id', 'sku_id');
        await addIndex('refunds', 'idx_status', 'status');

        // 3. Migrate stock from products
        console.log('Migrating stock from products to inventory...');
        await conn.execute(`
            INSERT INTO inventory (id, merchant_id, store_id, product_id, sku_id, stock, updated_at)
            SELECT CONCAT('inv_p_', id), merchant_id, store_id, id, '', stock, updated_at
            FROM products
            WHERE store_id IS NOT NULL AND store_id != ''
            ON DUPLICATE KEY UPDATE stock = VALUES(stock)
        `);

        // 4. Migrate stock from skus
        console.log('Migrating stock from skus to inventory...');
        await conn.execute(`
            INSERT INTO inventory (id, merchant_id, store_id, product_id, sku_id, stock, updated_at)
            SELECT CONCAT('inv_s_', id), merchant_id, store_id, product_id, id, stock, ?
            FROM skus
            WHERE store_id IS NOT NULL AND store_id != ''
            ON DUPLICATE KEY UPDATE stock = VALUES(stock)
        `, [Date.now()]);

        console.log('Migration completed successfully.');
    } catch (err) {
        console.error('Migration failed:', err);
    } finally {
        conn.release();
        process.exit();
    }
}

migrate();
