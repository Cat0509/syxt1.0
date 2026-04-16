const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');
require('dotenv').config();

async function run() {
    const pool = mysql.createPool({
        host: process.env.DB_HOST || 'localhost',
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || '',
        database: process.env.DB_NAME || 'ruyi_pos',
    });

    try {
        const [users] = await pool.query('SELECT * FROM users');
        for (let user of users) {
            if (!user.password_hash && user.password) {
                console.log(`Hashing password for user ${user.username}...`);
                const hash = await bcrypt.hash(user.password, 10);
                await pool.query('UPDATE users SET password_hash = ? WHERE id = ?', [hash, user.id]);
            }
        }
        console.log('Seed passwords hashed successfully!');
    } catch (e) {
        console.error(e);
    } finally {
        pool.end();
    }
}
run();
