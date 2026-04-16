const mysql = require('mysql2/promise');
async function test() {
    const conn = await mysql.createConnection({ host: 'localhost', user: 'root', password: '', database: 'ruyi_pos' });
    const [txCols] = await conn.execute('SHOW COLUMNS FROM transactions');
    console.log(JSON.stringify(txCols, null, 2));
    process.exit(0);
}
test();
