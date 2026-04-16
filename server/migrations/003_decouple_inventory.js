module.exports = {
    up: async (connection) => {
        // 1. Ensure inventory has all stock from products
        console.log('Migrating stock from products to inventory...');
        await connection.query(`
            INSERT INTO inventory (id, merchant_id, store_id, product_id, sku_id, stock, updated_at)
            SELECT 
                CONCAT('inv_p_', id), 
                merchant_id, 
                store_id, 
                id, 
                '', 
                stock, 
                UNIX_TIMESTAMP() * 1000
            FROM products 
            WHERE store_id IS NOT NULL AND stock > 0
            ON DUPLICATE KEY UPDATE 
                stock = GREATEST(inventory.stock, VALUES(stock)),
                updated_at = VALUES(updated_at)
        `);

        // 2. Ensure inventory has all stock from skus
        console.log('Migrating stock from skus to inventory...');
        await connection.query(`
            INSERT INTO inventory (id, merchant_id, store_id, product_id, sku_id, stock, updated_at)
            SELECT 
                CONCAT('inv_s_', id), 
                merchant_id, 
                store_id, 
                product_id, 
                id, 
                stock, 
                UNIX_TIMESTAMP() * 1000
            FROM skus 
            WHERE store_id IS NOT NULL AND stock > 0
            ON DUPLICATE KEY UPDATE 
                stock = GREATEST(inventory.stock, VALUES(stock)),
                updated_at = VALUES(updated_at)
        `);

        // 3. Create devices table
        console.log('Creating devices table...');
        await connection.query(`
            CREATE TABLE IF NOT EXISTS devices (
                id VARCHAR(50) PRIMARY KEY,
                name VARCHAR(100),
                store_id VARCHAR(50),
                last_login_at BIGINT,
                status ENUM('active', 'inactive') DEFAULT 'active',
                created_at BIGINT,
                FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE SET NULL
            )
        `);

        // 4. Add device_id to transactions if not exists
        console.log('Adding device_id to transactions...');
        try {
            await connection.query('ALTER TABLE transactions ADD COLUMN device_id VARCHAR(50)');
            await connection.query('ALTER TABLE transactions ADD CONSTRAINT fk_transactions_device FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE SET NULL');
        } catch (e) {
            if (e.code === 'ER_DUP_FIELDNAME') {
                console.log('Column device_id already exists in transactions.');
            } else {
                throw e;
            }
        }
    }
};
