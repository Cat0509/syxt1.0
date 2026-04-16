require('dotenv').config();
const mysql = require('mysql2/promise');

async function testConnection() {
    console.log('--- MySQL Connection Test ---');
    console.log('Host:', process.env.DB_HOST);
    console.log('User:', process.env.DB_USER);
    console.log('Database:', process.env.DB_NAME);

    try {
        const connection = await mysql.createConnection({
            host: process.env.DB_HOST || 'localhost',
            user: process.env.DB_USER || 'root',
            password: process.env.DB_PASSWORD || '',
            database: process.env.DB_NAME || 'ruyi_pos',
            port: process.env.DB_PORT || 3306
        });

        console.log('\n[SUCCESS] Connected to MySQL successfully!');

        const [tables] = await connection.execute('SHOW TABLES');
        console.log('\nFound tables:');
        tables.forEach(row => {
            console.log(' - ' + Object.values(row)[0]);
        });

        const [stores] = await connection.execute('SELECT COUNT(*) as count FROM stores');
        console.log(`\nStores count: ${stores[0].count}`);

        const [users] = await connection.execute('SELECT username, role FROM users');
        console.log('\nUsers found:');
        users.forEach(u => {
            console.log(` - ${u.username} (${u.role})`);
        });

        await connection.end();
        console.log('\n--- Test Completed ---');
    } catch (err) {
        console.error('\n[ERROR] Connection failed:');
        console.error(err.message);
        if (err.code === 'ER_BAD_DB_ERROR') {
            console.log('\nTip: The database ' + process.env.DB_NAME + ' does not exist. Please run mysql_schema.sql first.');
        } else if (err.code === 'ER_ACCESS_DENIED_ERROR') {
            console.log('\nTip: Access denied. Please check your DB_USER and DB_PASSWORD in .env.');
        }
    }
}

testConnection();
