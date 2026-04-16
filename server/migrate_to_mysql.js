require('dotenv').config();
const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcrypt');

const DB_FILE = path.join(__dirname, 'pos_data.json');

async function migrate() {
    if (!fs.existsSync(DB_FILE)) {
        console.log('No JSON data to migrate.');
        return;
    }

    const jsonData = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));

    const merchantId = process.env.MERCHANT_ID || 'm_default';
    const defaultStoreId = process.env.DEFAULT_STORE_ID || 's1';
    const defaultStoreName = process.env.DEFAULT_STORE_NAME || '旗舰店';

    const pool = mysql.createPool({
        host: process.env.DB_HOST || 'localhost',
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || '',
        database: process.env.DB_NAME || 'ruyi_pos',
        port: process.env.DB_PORT || 3306
    });

    try {
        console.log('Starting migration...');

        await pool.execute(
            'INSERT IGNORE INTO merchants (id, name, created_at) VALUES (?, ?, ?)',
            [merchantId, 'Migrated Merchant', Date.now()]
        );

        // 1. Migrate Stores (Default)
        console.log('Migrating stores...');
        await pool.execute(
            'INSERT IGNORE INTO stores (id, merchant_id, name, created_at) VALUES (?, ?, ?, ?)',
            [defaultStoreId, merchantId, defaultStoreName, Date.now()]
        );

        // 2. Migrate Users
        if (jsonData.users) {
            console.log(`Migrating ${jsonData.users.length} users...`);
            for (let u of jsonData.users) {
                try {
                    const role = u.role === 'admin' ? 'merchant_admin' : u.role;
                    const passwordHash = u.password ? await bcrypt.hash(u.password, 10) : null;

                    await pool.execute(
                        'INSERT IGNORE INTO users (id, merchant_id, username, password_hash, name, role, store_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
                        [u.id, merchantId, u.username, passwordHash, u.name, role, u.store_id || defaultStoreId, 'active', Date.now()]
                    );
                } catch (userErr) {
                    console.error(`Failed to migrate user ${u.username}:`, userErr.message);
                }
            }
        }

        // 3. Migrate Products & SKUs
        if (jsonData.products) {
            console.log(`Migrating ${jsonData.products.length} products...`);
            for (let p of jsonData.products) {
                try {
                    await pool.execute(
                        'INSERT IGNORE INTO products (id, merchant_id, name, price, category, barcode, stock, store_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
                        [p.id, merchantId, p.name, p.price, p.category, p.barcode, p.stock, p.store_id || defaultStoreId, p.updated_at || Date.now()]
                    );
                    if (p.skus) {
                        for (let s of p.skus) {
                            await pool.execute(
                                'INSERT IGNORE INTO skus (id, product_id, specName, price, stock, barcode) VALUES (?, ?, ?, ?, ?, ?)',
                                [s.id, p.id, s.specName, s.price, s.stock, s.barcode]
                            );
                        }
                    }
                } catch (prodErr) {
                    console.error(`Failed to migrate product ${p.name}:`, prodErr.message);
                }
            }
        }

        // 4. Migrate Transactions
        if (jsonData.transactions) {
            console.log(`Migrating ${jsonData.transactions.length} transactions...`);
            for (let tx of jsonData.transactions) {
                try {
                    await pool.execute(
                        'INSERT IGNORE INTO transactions (id, merchant_id, time, items, total, amount, payment, processed_by, store_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                        [
                            tx.id || ('TX' + tx.time),
                            merchantId,
                            tx.time || Date.now(),
                            typeof tx.items === 'string' ? tx.items : JSON.stringify(tx.items || []),
                            tx.total || tx.amount || 0,
                            tx.amount || tx.total || 0,
                            typeof tx.payment === 'string' ? tx.payment : JSON.stringify(tx.payment || {}),
                            tx.processed_by || '系统',
                            tx.store_id || defaultStoreId,
                            tx.updated_at || Date.now()
                        ]
                    );
                } catch (txErr) {
                    console.error(`Failed to migrate transaction ${tx.id || tx.time}:`, txErr.message);
                }
            }
        }

        console.log('\nMigration process finished.');
    } catch (err) {
        console.error('\nMigration failed with critical error:');
        console.error(err);
    } finally {
        await pool.end();
    }
}

migrate();
