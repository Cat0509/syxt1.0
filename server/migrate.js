const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
require('dotenv').config();

const dbConfig = {
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'ruyi_pos',
    port: process.env.DB_PORT || 3306,
    multipleStatements: true // Essential for running SQL scripts
};

async function migrate(rollback = false) {
    console.log(`--- Starting Database Migrations (${rollback ? 'ROLLBACK' : 'UP'}) ---`);
    let connection;
    try {
        connection = await mysql.createConnection(dbConfig);

        // 1. Ensure migrations table exists
        await connection.execute(`
            CREATE TABLE IF NOT EXISTS _migrations (
                id INT AUTO_INCREMENT PRIMARY KEY,
                name VARCHAR(255) NOT NULL UNIQUE,
                executed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // 2. Read migration files
        const migrationsDir = path.join(__dirname, 'migrations');
        if (!fs.existsSync(migrationsDir)) {
             fs.mkdirSync(migrationsDir);
        }
        
        const files = fs.readdirSync(migrationsDir)
            .filter(f => f.endsWith('.sql') || f.endsWith('.js'))
            .sort();

        if (rollback) {
            // Rollback the last executed migration
            const [rows] = await connection.execute('SELECT name FROM _migrations ORDER BY id DESC LIMIT 1');
            if (rows.length === 0) {
                console.log('No migrations to rollback.');
                return;
            }
            const file = rows[0].name;
            console.log(`Rolling back migration: ${file}`);
            const filePath = path.join(migrationsDir, file);

            if (file.endsWith('.js')) {
                const migration = require(filePath);
                if (typeof migration.down === 'function') {
                    await migration.down(connection);
                } else {
                    console.warn(`Migration ${file} does not export a 'down' function. Skipping logic, only removing from tracking table.`);
                }
            } else {
                console.warn(`SQL migration ${file} cannot be automatically rolled back. Please provide a manual SQL script.`);
            }

            await connection.execute('DELETE FROM _migrations WHERE name = ?', [file]);
            console.log(`Successfully rolled back: ${file}`);
        } else {
            // Forward migrations
            const [rows] = await connection.execute('SELECT name FROM _migrations');
            const executed = new Set(rows.map(r => r.name));

            for (const file of files) {
                if (!executed.has(file)) {
                    console.log(`Running migration: ${file}`);
                    const filePath = path.join(migrationsDir, file);

                    if (file.endsWith('.sql')) {
                        const sql = fs.readFileSync(filePath, 'utf8');
                        await connection.query(sql);
                    } else if (file.endsWith('.js')) {
                        const migration = require(filePath);
                        if (typeof migration.up === 'function') {
                            await migration.up(connection);
                        } else {
                            console.warn(`Migration ${file} does not export an 'up' function.`);
                        }
                    }

                    await connection.execute('INSERT INTO _migrations (name) VALUES (?)', [file]);
                    console.log(`Successfully completed: ${file}`);
                }
            }
        }

        console.log('--- Migration operation completed successfully ---');
    } catch (error) {
        console.error('Migration failed:', error);
        process.exit(1);
    } finally {
        if (connection) await connection.end();
    }
}

const isRollback = process.argv.includes('--rollback') || process.argv.includes('-r');
migrate(isRollback);
