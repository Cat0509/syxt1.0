const mysql = require('mysql2/promise');
require('dotenv').config();
const fs = require('fs');

async function run() {
    const conn = await mysql.createConnection({
        host: process.env.DB_HOST || 'localhost',
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || '',
        database: process.env.DB_NAME || 'ruyi_pos'
    });
    
    const output = { txCols: [], itemCols: [], migrations: [] };
    
    const [txCols] = await conn.execute("SHOW COLUMNS FROM transactions");
    txCols.forEach(c => {
        if (['business_date', 'offline_cash_collected', 'offline_payment_pending', 'offline_id'].includes(c.Field)) {
            output.txCols.push(c);
        }
    });

    const [itemCols] = await conn.execute("SHOW COLUMNS FROM order_items");
    itemCols.forEach(c => {
        if (c.Field === 'price_snapshot') {
            output.itemCols.push(c);
        }
    });

    try {
        const [migs] = await conn.execute("SELECT * FROM _migrations");
        output.migrations = migs;
    } catch(e) {}
    
    await conn.end();
    fs.writeFileSync('schema_output.json', JSON.stringify(output, null, 2));
}
run();
