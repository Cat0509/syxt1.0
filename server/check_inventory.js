const mysql = require('mysql2/promise');
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '.env') });

async function checkInventory() {
    const conn = await mysql.createConnection({
        host: process.env.DB_HOST || 'localhost',
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME || 'ruyi_pos',
        port: process.env.DB_PORT || 3306
    });

    try {
        const [inv] = await conn.execute('SELECT * FROM inventory WHERE merchant_id = "m_default"');
        const [prod] = await conn.execute('SELECT id, name, stock FROM products WHERE merchant_id = "m_default"');

        fs.writeFileSync(path.join(__dirname, 'inv_state.json'), JSON.stringify({
            inventory: inv,
            products: prod
        }, null, 2));

        console.log('Stock state written to inv_state.json');
    } catch (err) {
        console.error(err);
    } finally {
        await conn.end();
    }
}

checkInventory();
