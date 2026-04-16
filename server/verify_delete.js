const mysql = require('mysql2/promise');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

async function verify() {
    console.log('--- Database State Check ---');
    const conn = await mysql.createConnection({
        host: process.env.DB_HOST || 'localhost',
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || '',
        database: process.env.DB_NAME || 'ruyi_pos'
    });

    try {
        const [rows] = await conn.execute('SELECT id, name FROM products WHERE name LIKE ?', ['%Smoke%']);
        console.log('Smoke products in DB:', rows);
        
        if (rows.length > 0) {
            const targetId = rows[0].id;
            console.log(`Targeting ID: ${targetId} for deletion test...`);
            
            const db = require('./db');
            await db.deleteProduct(targetId, 'm_default');
            
            const [rowsAfter] = await conn.execute('SELECT id, name FROM products WHERE id = ?', [targetId]);
            console.log('Post-delete check (Products):', rowsAfter.length === 0 ? 'SUCCESS: DELETED' : 'FAILURE: STILL EXISTS');
            
            const [skusAfter] = await conn.execute('SELECT id FROM skus WHERE product_id = ?', [targetId]);
            console.log('Post-delete check (SKUs):', skusAfter.length === 0 ? 'SUCCESS: DELETED' : 'FAILURE: STILL EXISTS');
            
            const [invAfter] = await conn.execute('SELECT id FROM inventory WHERE product_id = ?', [targetId]);
            console.log('Post-delete check (Inventory):', invAfter.length === 0 ? 'SUCCESS: DELETED' : 'FAILURE: STILL EXISTS');
        } else {
            console.log('No smoke product found to test deletion on. It might have been deleted already or never existed in the DB.');
        }
    } catch (e) {
        console.error('Test failed:', e);
    } finally {
        await conn.end();
        process.exit(0);
    }
}

verify();
