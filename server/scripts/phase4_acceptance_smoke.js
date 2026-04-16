const path = require('path');
const { spawn } = require('child_process');
const mysql = require('mysql2/promise');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const serverDir = path.resolve(__dirname, '..');
const baseUrl = process.env.PHASE3_BASE_URL || 'http://localhost:3000';
const apiBase = `${baseUrl}/api/v1`;

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestJson(pathname, { method = 'GET', token, body, expectedStatus = 200 } = {}) {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    const response = await fetch(`${apiBase}${pathname}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body)
    });

    const raw = await response.text();
    let payload = null;
    if (raw) {
        try {
            payload = JSON.parse(raw);
        } catch {
            payload = { raw };
        }
    }

    const expected = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus];
    if (!expected.includes(response.status)) {
        const error = new Error(`Unexpected status ${response.status} for ${method} ${pathname}`);
        error.status = response.status;
        error.payload = payload;
        throw error;
    }

    return { status: response.status, payload };
}

async function isHealthy() {
    try {
        const response = await fetch(`${baseUrl}/health`);
        return response.ok;
    } catch {
        return false;
    }
}

async function ensureServer() {
    if (await isHealthy()) {
        return { owned: false, child: null };
    }

    const child = spawn(process.execPath, ['index.js'], {
        cwd: serverDir,
        stdio: 'ignore',
        windowsHide: true,
        env: { ...process.env, PORT: 3000 }
    });

    for (let i = 0; i < 20; i += 1) {
        await sleep(500);
        if (await isHealthy()) {
            return { owned: true, child };
        }
    }

    throw new Error('Server health check failed');
}

function stopServer(serverContext) {
    if (!serverContext?.owned || !serverContext.child) return;
    try {
        serverContext.child.kill();
    } catch {
        // ignore cleanup failures
    }
}

async function getDbConnection() {
    return mysql.createConnection({
        host: process.env.DB_HOST || 'localhost',
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || '',
        database: process.env.DB_NAME || 'ruyi_pos',
        port: process.env.DB_PORT || 3306
    });
}

async function main() {
    console.log('Starting Phase 4 Smoke Test...');
    const serverContext = await ensureServer();
    const conn = await getDbConnection();

    try {
        const report = {
            checks: {},
            timestamp: new Date().toISOString()
        };

        // 1. Check Schema (New Phase 4 Columns)
        console.log('Checking Schema...');
        const [txCols] = await conn.execute('SHOW COLUMNS FROM transactions');
        const [itemCols] = await conn.execute('SHOW COLUMNS FROM order_items');
        
        report.checks.business_date_correct = txCols.some(c => c.Field === 'business_date' && c.Type.includes('bigint'));
        report.checks.offline_cash_collected_correct = txCols.some(c => c.Field === 'offline_cash_collected' && c.Type.includes('decimal'));
        report.checks.offline_payment_pending_correct = txCols.some(c => c.Field === 'offline_payment_pending' && (c.Type.includes('tinyint') || c.Type.includes('bool')));
        report.checks.offline_id_correct = txCols.some(c => c.Field === 'offline_id' && c.Type.includes('varchar'));
        report.checks.price_snapshot_correct = itemCols.some(c => c.Field === 'price_snapshot' && c.Type.includes('decimal'));

        // 2. Check Initialization Status
        console.log('Checking Initialization Status...');
        const initStatus = await requestJson('/auth/init-status');
        report.checks.init_status_returned = initStatus.payload.data.initialized === true;

        // 3. Login with standard admin
        console.log('Logging in...');
        const auth = await requestJson('/auth/login', {
            method: 'POST',
            body: { merchantId: 'm_default', username: 'admin', password: 'admin' }
        });
        const token = auth.payload.data.token;

        // 4. Test ID Strategy (Transaction & Items)
        console.log('Testing ID Strategy...');
        const smokeSuffix = Date.now();
        const smokeStoreId = 's1';
        const smokeProduct = {
            id: `p4_smoke_product_${smokeSuffix}`,
            name: 'P4 Smoke Product',
            price: 99.9,
            stock: 5,
            category: 'Test',
            barcode: `p4_${smokeSuffix}`,
            store_id: smokeStoreId,
            skus: []
        };
        const clientTxId = `p4_smoke_${smokeSuffix}`;
        const deviceId = `p4_smoke_device_${smokeSuffix}`;

        await requestJson(`/products/sync?store_id=${smokeStoreId}`, {
            method: 'POST',
            token,
            body: { products: [smokeProduct] }
        });

        // Ensure device exists first (Foreign Key constraint)
        await conn.execute(
            `INSERT INTO devices (id, name, store_id, status, created_at, last_login_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE name = VALUES(name), store_id = VALUES(store_id), status = VALUES(status), last_login_at = VALUES(last_login_at)`,
            [deviceId, 'Smoke Test Device', smokeStoreId, 'active', Date.now(), Date.now()]
        );
        
        const createOrder = await requestJson('/orders', {
            method: 'POST',
            token,
            body: {
                client_tx_id: clientTxId,
                device_id: deviceId,
                store_id: smokeStoreId,
                total: smokeProduct.price,
                amount: smokeProduct.price,
                items: [{
                    product_id: smokeProduct.id,
                    name: smokeProduct.name,
                    price: smokeProduct.price,
                    qty: 1
                }]
            }
        });

        const orderId = createOrder.payload.data.order_id;
        const orderNo = createOrder.payload.data.order_no;

        report.checks.order_id_is_uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(orderId);
        report.checks.order_no_format_ok = orderNo.startsWith('S') && orderNo.includes('-');

        // 5. Verify Transaction Data model (no JSON items)
        console.log('Verifying data model implementation...');
        const [txRow] = await conn.execute('SELECT items, device_id FROM transactions WHERE id = ?', [orderId]);
        report.checks.json_items_is_empty_array = txRow[0].items === '[]';
        report.checks.device_id_captured = txRow[0].device_id === deviceId;

        // 6. Verify Stock Decoupling (Inventory Table vs Products Table)
        console.log('Verifying stock decoupling...');
        const [prodRow] = await conn.execute('SELECT stock FROM products WHERE id = ?', [smokeProduct.id]);
        const [invRow] = await conn.execute(
            'SELECT stock FROM inventory WHERE merchant_id = ? AND store_id = ? AND product_id = ? AND sku_id = ?',
            ['m_default', smokeStoreId, smokeProduct.id, '']
        );
        report.checks.inventory_deducted = invRow.length > 0 && invRow[0].stock === smokeProduct.stock - 1;
        report.checks.products_stock_unchanged = prodRow.length > 0 && prodRow[0].stock === 0;

        // 7. Check Sync Status field mapping
        console.log('Checking Sync Status mappings...');
        const syncStatus = await requestJson(`/sync/status/${deviceId}`);
        report.checks.sync_status_fields_ok = syncStatus.payload.data.hasOwnProperty('last_sync_at') && 
                                              syncStatus.payload.data.hasOwnProperty('is_active');

        // 8. Result Summary
        const failed = Object.entries(report.checks).filter(([k, v]) => !v).map(([k]) => k);
        report.success = failed.length === 0;
        report.failed_count = failed.length;
        report.failed_checks = failed;

        console.log(JSON.stringify(report, null, 2));
        
        if (!report.success) {
            process.exit(1);
        } else {
            console.log('Phase 4 Smoke Test PASSED');
        }

    } catch (err) {
        console.error('Smoke Test Error:', err);
        process.exit(1);
    } finally {
        await conn.end();
        stopServer(serverContext);
    }
}

main();
