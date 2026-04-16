const mysql = require('mysql2/promise');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

async function syncInventory() {
    const conn = await mysql.createConnection({
        host: process.env.DB_HOST || 'localhost',
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME || 'ruyi_pos',
        port: process.env.DB_PORT || 3306
    });

    try {
        const merchantId = 'm_default';
        const storeId = 's1';
        const now = Date.now();

        console.log(`Syncing stock for merchant: ${merchantId}, store: ${storeId}...`);

        // 1. Sync from products table (simple products)
        // Note: products.stock is deprecated but has the restored data
        await conn.execute(`
            INSERT INTO inventory (id, merchant_id, store_id, product_id, sku_id, stock, updated_at)
            SELECT 
                CONCAT('inv_p_', id, '_', ?), 
                merchant_id, 
                ?, 
                id, 
                '', 
                stock, 
                ?
            FROM products 
            WHERE merchant_id = ? AND stock > 0
            ON DUPLICATE KEY UPDATE 
                stock = VALUES(stock),
                updated_at = VALUES(updated_at)
        `, [storeId, storeId, now, merchantId]);

        // 2. Sync from skus table
        await conn.execute(`
            INSERT INTO inventory (id, merchant_id, store_id, product_id, sku_id, stock, updated_at)
            SELECT 
                CONCAT('inv_s_', id, '_', ?), 
                merchant_id, 
                ?, 
                product_id, 
                id, 
                stock, 
                ?
            FROM skus 
            WHERE merchant_id = ? AND stock > 0
            ON DUPLICATE KEY UPDATE 
                stock = VALUES(stock),
                updated_at = VALUES(updated_at)
        `, [storeId, storeId, now, merchantId]);

        console.log('Stock synchronization completed successfully.');
    } catch (err) {
        console.error('Inventory sync failed:', err);
    } finally {
        await conn.end();
    }
}

syncInventory();
