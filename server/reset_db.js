const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

async function reset() {
    const pool = mysql.createPool({
        host: process.env.DB_HOST || 'localhost',
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || '',
        port: process.env.DB_PORT || 3306,
        multipleStatements: true
    });

    try {
        const dbName = process.env.DB_NAME || 'ruyi_pos';
        console.log(`Resetting database: ${dbName}...`);

        // Drop and Recreate Database to ensure clean slate
        await pool.query(`DROP DATABASE IF EXISTS ${dbName}`);
        await pool.query(`CREATE DATABASE ${dbName}`);
        await pool.query(`USE ${dbName}`);

        // Execute progressive migrations instead of a static schema
        console.log('Executing migrations via migrate.js...');
        const { execSync } = require('child_process');
        execSync('node migrate.js', { stdio: 'inherit', cwd: __dirname });

        console.log('Database reset and migrations applied successfully!');
    } catch (err) {
        console.error('Failed to reset database:', err);
    } finally {
        await pool.end();
    }
}

reset();
