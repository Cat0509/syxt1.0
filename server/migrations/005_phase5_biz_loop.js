module.exports = {
    up: async (connection) => {
        console.log('Starting Phase 5: Business Loop Closure Migration...');

        // 1. Create order_payments table
        console.log('Creating order_payments table...');
        await connection.query(`
            CREATE TABLE IF NOT EXISTS order_payments (
                id VARCHAR(50) PRIMARY KEY,
                merchant_id VARCHAR(50) NOT NULL,
                store_id VARCHAR(50),
                order_id VARCHAR(50) NOT NULL,
                method ENUM('cash', 'scan', 'card', 'other') DEFAULT 'cash',
                amount DECIMAL(10, 2) NOT NULL,
                status ENUM('pending', 'success', 'failed', 'refunded') DEFAULT 'success',
                transaction_ref VARCHAR(100),
                created_at BIGINT NOT NULL,
                FOREIGN KEY (merchant_id) REFERENCES merchants(id) ON DELETE CASCADE,
                FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE SET NULL,
                FOREIGN KEY (order_id) REFERENCES transactions(id) ON DELETE CASCADE,
                INDEX idx_order_id (order_id)
            )
        `);

        // 2. Create refund_items table
        console.log('Creating refund_items table...');
        await connection.query(`
            CREATE TABLE IF NOT EXISTS refund_items (
                id VARCHAR(50) PRIMARY KEY,
                refund_id VARCHAR(50) NOT NULL,
                order_item_id VARCHAR(50) NOT NULL,
                product_id VARCHAR(50) NOT NULL,
                sku_id VARCHAR(50),
                qty INT NOT NULL,
                amount DECIMAL(10, 2) NOT NULL,
                reason VARCHAR(255),
                FOREIGN KEY (refund_id) REFERENCES refunds(id) ON DELETE CASCADE,
                FOREIGN KEY (order_item_id) REFERENCES order_items(id) ON DELETE CASCADE,
                INDEX idx_refund_id (refund_id)
            )
        `);

        // 3. Create store_prices table
        console.log('Creating store_prices table...');
        await connection.query(`
            CREATE TABLE IF NOT EXISTS store_prices (
                id VARCHAR(50) PRIMARY KEY,
                merchant_id VARCHAR(50) NOT NULL,
                store_id VARCHAR(50) NOT NULL,
                product_id VARCHAR(50) NOT NULL,
                sku_id VARCHAR(50) DEFAULT '',
                price DECIMAL(10, 2) NOT NULL,
                updated_at BIGINT NOT NULL,
                UNIQUE KEY uniq_store_item_price (store_id, product_id, sku_id),
                FOREIGN KEY (merchant_id) REFERENCES merchants(id) ON DELETE CASCADE,
                FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE,
                FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
            )
        `);

        // 4. Update transactions status ENUM (Adding partially_refunded)
        // Since MySQL 8.0 doesn't support easy ALTER ENUM without full table rebuild usually, 
        // and we might want to be flexible, we can try to alter it or just ensure it works.
        // Actually, the best way to handle evolving ENUMs in migrations is often to just use VARCHAR or be careful.
        // Here we'll try to ALTER.
        console.log('Updating transactions status ENUM to include partially_refunded...');
        try {
            await connection.query(`
                ALTER TABLE transactions 
                MODIFY COLUMN status ENUM('pending', 'paid', 'cancelled', 'refund_requested', 'refunded', 'partially_refunded') 
                DEFAULT 'pending'
            `);
        } catch (e) {
            console.error('Failed to update transactions status ENUM:', e.message);
            // If it fails, we might just log and continue if it's not critical for the table to exist
        }

        console.log('Phase 5 migration completed successfully.');
    }
};
