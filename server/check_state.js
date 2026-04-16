const mysql = require('mysql2/promise');
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '.env') });

async function check() {
    const conn = await mysql.createConnection({
        host: process.env.DB_HOST || 'localhost',
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME || 'ruyi_pos',
        port: process.env.DB_PORT || 3306
    });

    try {
        const [merchants] = await conn.execute('SELECT id, name FROM merchants');
        const [stores] = await conn.execute('SELECT id, merchant_id, name FROM stores');
        const [products] = await conn.execute('SELECT id, merchant_id, name, price FROM products');

        const output = {
            merchants,
            stores,
            products
        };

        fs.writeFileSync(path.join(__dirname, 'db_state.json'), JSON.stringify(output, null, 2));
        console.log('Results written to db_state.json');

    } catch (err) {
        console.error('Check failed:', err);
    } finally {
        await conn.end();
    }
}

check();
