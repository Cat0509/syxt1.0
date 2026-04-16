/**
 * Phase 4: Offline Foundation Migration
 * Adds fields required for robust offline operation and business day tracking.
 */
module.exports = {
    up: async (connection) => {
        console.log('Adding offline foundation fields to transactions and order_items...');
        
        // Helper to add a column if it doesn't exist
        const addColumn = async (table, definition) => {
            try {
                await connection.execute(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
                console.log(`Added column: ${definition} to ${table}`);
            } catch (err) {
                if (err.code === 'ER_DUP_FIELDNAME') {
                    console.log(`Column already exists in ${table}, skipping.`);
                } else {
                    throw err;
                }
            }
        };

        // 1. Transactions table enhancements
        await addColumn('transactions', 'business_date BIGINT AFTER time');
        await addColumn('transactions', 'offline_cash_collected DECIMAL(10, 2) DEFAULT 0');
        await addColumn('transactions', 'offline_payment_pending BOOLEAN DEFAULT FALSE');
        await addColumn('transactions', 'offline_id VARCHAR(50) UNIQUE AFTER client_tx_id');

        // 2. Order Items table enhancements
        await addColumn('order_items', 'price_snapshot DECIMAL(10, 2) AFTER price');

        console.log('Offline foundation fields processed.');
    },

    down: async (connection) => {
        console.log('Removing offline foundation fields...');
        
        const dropColumn = async (table, column) => {
            try {
                await connection.execute(`ALTER TABLE ${table} DROP COLUMN ${column}`);
                console.log(`Dropped column: ${column} from ${table}`);
            } catch (err) {
                 if (err.code === 'ER_CANT_DROP_FIELD_OR_KEY') {
                     console.log(`Column ${column} does not exist in ${table}, skipping.`);
                 } else {
                     throw err;
                 }
            }
        };

        await dropColumn('transactions', 'business_date');
        await dropColumn('transactions', 'offline_cash_collected');
        await dropColumn('transactions', 'offline_payment_pending');
        await dropColumn('transactions', 'offline_id');
        await dropColumn('order_items', 'price_snapshot');

        console.log('Offline foundation fields removed.');
    }
};
