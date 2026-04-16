const mysql = require('mysql2/promise');
require('dotenv').config();

const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'ruyi_pos',
    port: process.env.DB_PORT || 3306
});

async function checkAndFix() {
    const conn = await pool.getConnection();
    const dbName = process.env.DB_NAME || 'ruyi_pos';

    try {
        const schema = {
            products: ['merchant_id', 'store_id', 'stock', 'updated_at'],
            skus: ['merchant_id', 'store_id', 'stock', 'product_id'],
            transactions: ['merchant_id', 'store_id', 'client_tx_id', 'order_no'],
            inventory_movements: ['merchant_id', 'store_id'],
            refunds: ['merchant_id'],
            audit_logs: ['merchant_id', 'store_id']
        };
        
        for (const [table, requiredCols] of Object.entries(schema)) {
            console.log(`Checking table: ${table}`);
            const [columns] = await conn.execute(`SHOW COLUMNS FROM ${table}`);
            const columnNames = columns.map(c => c.Field);
            
            for (const col of requiredCols) {
                if (!columnNames.includes(col)) {
                    console.log(`  - Adding missing '${col}' to ${table}...`);
                    let afterCol = columnNames[0]; // Default to after first column
                    if (col === 'merchant_id') afterCol = 'id';
                    await conn.execute(`ALTER TABLE ${table} ADD COLUMN ${col} VARCHAR(100) DEFAULT NULL AFTER ${afterCol}`);
                }
            }
        }
        
        console.log('Database check and fix completed.');
    } catch (err) {
        console.error('Error during database check:', err.message);
    } finally {
        conn.release();
        process.exit();
    }
}

checkAndFix();
