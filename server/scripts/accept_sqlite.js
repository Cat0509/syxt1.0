/**
 * SQLite Acceptance Test
 *
 * Uses better-sqlite3 (not mysql2) and the native http module (not fetch).
 * Uses a TEMPORARY database (accept_test_<timestamp>.db) to avoid touching
 * the real development data.db.
 *
 * Starts the server on a dynamic port, captures stdout/stderr for diagnostics,
 * and runs a full business-flow smoke test.
 */

const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const os = require('os');

// Resolve better-sqlite3 through normal Node resolution so the script works
// both with server-local dependencies and with root-level Electron app deps.
const Database = require('better-sqlite3');

// ---------------------------------------------------------------------------
// Configuration — use a TEMPORARY database, never the real data.db
// ---------------------------------------------------------------------------
const serverDir = path.resolve(__dirname, '..');
const testId = `accept_${Date.now()}`;
const dbPath = path.join(os.tmpdir(), `ruyi_pos_${testId}.db`);

// Find a free port dynamically
function findFreePort() {
    return new Promise((resolve, reject) => {
        const srv = require('net').createServer();
        srv.listen(0, '127.0.0.1', () => {
            const port = srv.address().port;
            srv.close(() => resolve(port));
        });
        srv.on('error', reject);
    });
}

let PORT;
let baseUrl;
let apiBase;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Send an HTTP request using the native http module.
 */
function httpRequest(urlStr, { method = 'GET', headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
        const url = new URL(urlStr);
        const options = {
            hostname: url.hostname,
            port: url.port,
            path: url.pathname + url.search,
            method,
            headers,
        };

        const req = http.request(options, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
                const raw = Buffer.concat(chunks).toString('utf-8');
                resolve({ status: res.statusCode, headers: res.headers, body: raw });
            });
        });

        req.on('error', reject);
        if (body !== undefined) {
            req.write(body);
        }
        req.end();
    });
}

/**
 * Convenience wrapper: JSON request/response.
 */
async function requestJson(pathname, { method = 'GET', token, body, expectedStatus = 200 } = {}) {
    const headers = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify(body);
    }

    const { status, body: raw } = await httpRequest(`${apiBase}${pathname}`, {
        method,
        headers,
        body,
    });

    let payload = null;
    if (raw) {
        try {
            payload = JSON.parse(raw);
        } catch {
            payload = { raw };
        }
    }

    const expected = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus];
    if (!expected.includes(status)) {
        const error = new Error(`Unexpected status ${status} for ${method} ${pathname}`);
        error.status = status;
        error.payload = payload;
        throw error;
    }

    return { status, payload };
}

// ---------------------------------------------------------------------------
// Server lifecycle — captures stdout/stderr for diagnostics
// ---------------------------------------------------------------------------
let serverStdout = [];
let serverStderr = [];

async function isHealthy() {
    try {
        const { status } = await httpRequest(`${baseUrl}/health`);
        return status === 200;
    } catch {
        return false;
    }
}

async function ensureServer() {
    if (await isHealthy()) {
        return { owned: false, child: null };
    }

    serverStdout = [];
    serverStderr = [];

    const child = spawn(process.execPath, ['index.js'], {
        cwd: serverDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: {
            ...process.env,
            PORT: String(PORT),
            DB_PATH: dbPath,
            // Disable auto-backup and order-timeout during tests to reduce noise
            BACKUP_DIR: path.join(os.tmpdir(), `ruyi_pos_backups_${testId}`),
        },
    });

    child.stdout.on('data', (data) => {
        const line = data.toString();
        serverStdout.push(line);
    });
    child.stderr.on('data', (data) => {
        const line = data.toString();
        serverStderr.push(line);
    });

    for (let i = 0; i < 60; i++) {
        await sleep(500);
        if (await isHealthy()) {
            return { owned: true, child };
        }
    }

    // Health check failed — dump server logs for diagnosis
    console.error('\n=== Server stdout (last 30 lines) ===');
    serverStdout.slice(-30).forEach(l => console.error(l.trimEnd()));
    console.error('\n=== Server stderr (last 30 lines) ===');
    serverStderr.slice(-30).forEach(l => console.error(l.trimEnd()));
    console.error('');

    throw new Error(`Server health check failed after 30 seconds on port ${PORT}`);
}

function stopServer(serverContext) {
    if (!serverContext?.owned || !serverContext.child) return;
    try {
        serverContext.child.kill();
    } catch {
        // ignore cleanup failures
    }
}

// ---------------------------------------------------------------------------
// Cleanup helper
// ---------------------------------------------------------------------------
function cleanupTestFiles() {
    for (const ext of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(dbPath + ext); } catch {}
    }
    // Clean backup dir
    const backupDir = path.join(os.tmpdir(), `ruyi_pos_backups_${testId}`);
    try { fs.rmSync(backupDir, { recursive: true, force: true }); } catch {}
}

// ---------------------------------------------------------------------------
// SQLite direct access
// ---------------------------------------------------------------------------
function openDb() {
    return new Database(dbPath);
}

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------
let passed = 0;
let failed = 0;

function assert(condition, label) {
    if (condition) {
        passed++;
        console.log(`  [PASS] ${label}`);
    } else {
        failed++;
        console.error(`  [FAIL] ${label}`);
    }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
    console.log('=== SQLite Acceptance Test ===\n');
    console.log(`[Setup] Test DB: ${dbPath}`);

    // Ensure we NEVER touch the real data.db
    const realDbPath = path.join(serverDir, 'data.db');
    if (fs.existsSync(realDbPath)) {
        console.log(`[Setup] Real data.db exists at ${realDbPath} — will NOT be modified`);
    }

    // Find a free port
    PORT = await findFreePort();
    baseUrl = `http://127.0.0.1:${PORT}`;
    apiBase = `${baseUrl}/api/v1`;
    console.log(`[Setup] Using port: ${PORT}\n`);

    const serverContext = await ensureServer();
    console.log('[Setup] Server is healthy\n');

    try {
        // -------------------------------------------------------------------
        // 1. Health check
        // -------------------------------------------------------------------
        console.log('--- Test 1: Health Check GET /health ---');
        const health = await httpRequest(`${baseUrl}/health`);
        assert(health.status === 200, 'GET /health returns 200');
        const healthPayload = JSON.parse(health.body);
        assert(healthPayload.code === 0 || healthPayload.data?.status === 'OK', 'Health response contains OK status');
        console.log('');

        // -------------------------------------------------------------------
        // 2. Init status (should be false for empty DB)
        // -------------------------------------------------------------------
        console.log('--- Test 2: Init Status GET /api/v1/auth/init-status ---');
        const initStatus = await requestJson('/auth/init-status');
        assert(initStatus.payload.data.initialized === false, 'init-status returns false for empty DB');
        console.log('');

        // -------------------------------------------------------------------
        // 3. Init setup
        // -------------------------------------------------------------------
        console.log('--- Test 3: Init Setup POST /api/v1/auth/init-setup ---');
        const initSetup = await requestJson('/auth/init-setup', {
            method: 'POST',
            body: {
                merchantName: 'Test Merchant',
                adminName: 'Test Admin',
                username: 'admin',
                password: 'admin123',
                storeName: 'Test Store',
                deviceId: 'device_test_001',
                deviceName: 'Test Device',
            },
        });
        assert(initSetup.status === 200, 'init-setup returns 200');
        assert(initSetup.payload.data.merchantId != null, 'init-setup returns merchantId');
        assert(initSetup.payload.data.adminId != null, 'init-setup returns adminId');
        const merchantId = initSetup.payload.data.merchantId;
        console.log('');

        // -------------------------------------------------------------------
        // 4. Login
        // -------------------------------------------------------------------
        console.log('--- Test 4: Login POST /api/v1/auth/login ---');
        const login = await requestJson('/auth/login', {
            method: 'POST',
            body: { merchantId, username: 'admin', password: 'admin123' },
        });
        assert(login.status === 200, 'Login returns 200');
        assert(login.payload.data.token != null, 'Login returns a token');
        const token = login.payload.data.token;
        console.log('');

        // -------------------------------------------------------------------
        // 5. Product sync
        // -------------------------------------------------------------------
        console.log('--- Test 5: Product Sync POST /api/v1/products/sync ---');
        const smokeSuffix = Date.now();
        const storeId = initSetup.payload.data.storeId || 's1';
        const db = openDb();
        const storeRow = db.prepare('SELECT id FROM stores LIMIT 1').get();
        const effectiveStoreId = storeRow ? storeRow.id : storeId;
        db.close();

        const productId = `prod_sqlite_${smokeSuffix}`;
        const productPayload = {
            products: [
                {
                    id: productId,
                    name: 'SQLite Test Product',
                    price: 25.50,
                    stock: 10,
                    category: 'Test',
                    barcode: `bc_${smokeSuffix}`,
                    store_id: effectiveStoreId,
                    skus: [],
                },
            ],
        };

        const syncResult = await requestJson(`/products/sync?store_id=${effectiveStoreId}`, {
            method: 'POST',
            token,
            body: productPayload,
        });
        assert(syncResult.status === 200, 'Product sync returns 200');

        const verifyDb = openDb();
        const prodRow = verifyDb.prepare('SELECT * FROM products WHERE id = ?').get(productId);
        assert(prodRow != null, 'Product exists in SQLite database');
        assert(prodRow.name === 'SQLite Test Product', 'Product name matches');

        const invRow = verifyDb.prepare(
            'SELECT * FROM inventory WHERE product_id = ? AND store_id = ? AND sku_id = ?'
        ).get(productId, effectiveStoreId, '');
        assert(invRow != null, 'Inventory row created for product');
        assert(invRow.stock === 10, 'Inventory stock initialized to 10');
        verifyDb.close();
        console.log('');

        // -------------------------------------------------------------------
        // 6. Create order
        // -------------------------------------------------------------------
        console.log('--- Test 6: Create Order POST /api/v1/orders ---');
        const clientTxId = `tx_sqlite_${smokeSuffix}`;
        const deviceId = 'device_test_001';

        const createOrder = await requestJson('/orders', {
            method: 'POST',
            token,
            body: {
                client_tx_id: clientTxId,
                device_id: deviceId,
                store_id: effectiveStoreId,
                total: 25.50,
                amount: 25.50,
                payment_method: 'cash',
                items: [
                    {
                        product_id: productId,
                        name: 'SQLite Test Product',
                        price: 25.50,
                        qty: 1,
                    },
                ],
            },
        });
        assert(createOrder.status === 200, 'Create order returns 200');
        assert(createOrder.payload.data.order_id != null, 'Order ID returned');
        assert(createOrder.payload.data.order_no != null, 'Order number returned');
        const orderId = createOrder.payload.data.order_id;
        console.log('');

        // -------------------------------------------------------------------
        // 7. Cash payment
        // -------------------------------------------------------------------
        console.log('--- Test 7: Cash Payment POST /api/v1/payments/create ---');
        const paymentResult = await requestJson('/payments/create', {
            method: 'POST',
            token,
            body: {
                order_id: orderId,
                amount: 25.50,
                method: 'cash',
            },
        });
        assert(paymentResult.status === 200, 'Cash payment returns 200');
        assert(paymentResult.payload.data.payment_id != null, 'Payment ID returned');
        assert(paymentResult.payload.data.payment_status === 'paid', 'Payment status is paid (cash immediate)');
        console.log('');

        // -------------------------------------------------------------------
        // 8. Check order status
        // -------------------------------------------------------------------
        console.log('--- Test 8: Check Order Status ---');
        const checkDb = openDb();
        const txRow = checkDb.prepare('SELECT * FROM transactions WHERE id = ?').get(orderId);
        assert(txRow != null, 'Order exists in database');
        assert(txRow.status === 'paid', 'Order status is paid');
        assert(txRow.payment_status === 'paid', 'Order payment_status is paid');

        const invAfterOrder = checkDb.prepare(
            'SELECT stock FROM inventory WHERE product_id = ? AND store_id = ? AND sku_id = ?'
        ).get(productId, effectiveStoreId, '');
        assert(invAfterOrder.stock === 9, 'Inventory deducted from 10 to 9');

        const orderItems = checkDb.prepare('SELECT * FROM order_items WHERE order_id = ?').all(orderId);
        assert(orderItems.length === 1, 'One order item recorded');
        assert(orderItems[0].name === 'SQLite Test Product', 'Order item name matches');

        const orderPayments = checkDb.prepare('SELECT * FROM order_payments WHERE order_id = ?').all(orderId);
        assert(orderPayments.length === 1, 'One payment record exists');
        assert(orderPayments[0].method === 'cash', 'Payment method is cash');
        checkDb.close();
        console.log('');

        // -------------------------------------------------------------------
        // 9. Create another order and cancel it
        // -------------------------------------------------------------------
        console.log('--- Test 9: Cancel Order POST /api/v1/orders/:id/cancel ---');
        const cancelTxId = `tx_cancel_${smokeSuffix}`;
        const cancelOrder = await requestJson('/orders', {
            method: 'POST',
            token,
            body: {
                client_tx_id: cancelTxId,
                device_id: deviceId,
                store_id: effectiveStoreId,
                total: 25.50,
                amount: 25.50,
                payment_method: 'cash',
                items: [
                    {
                        product_id: productId,
                        name: 'SQLite Test Product',
                        price: 25.50,
                        qty: 1,
                    },
                ],
            },
        });
        assert(cancelOrder.status === 200, 'Cancel target order created');
        const cancelOrderId = cancelOrder.payload.data.order_id;

        const cancelResult = await requestJson(`/orders/${cancelOrderId}/cancel`, {
            method: 'POST',
            token,
        });
        assert(cancelResult.status === 200, 'Cancel order returns 200');
        assert(cancelResult.payload.data.order_id === cancelOrderId, 'Cancel response contains correct order_id');

        const cancelDb = openDb();
        const cancelledTx = cancelDb.prepare('SELECT * FROM transactions WHERE id = ?').get(cancelOrderId);
        assert(cancelledTx.status === 'cancelled', 'Order status is cancelled');
        assert(cancelledTx.payment_status === 'unpaid', 'Order payment_status is unpaid (not refunded for unpaid cancellations)');

        const invAfterCancel = cancelDb.prepare(
            'SELECT stock FROM inventory WHERE product_id = ? AND store_id = ? AND sku_id = ?'
        ).get(productId, effectiveStoreId, '');
        assert(invAfterCancel.stock === 9, 'Inventory restored back to 9 after cancel');
        cancelDb.close();
        console.log('');

        // -------------------------------------------------------------------
        // 10. Check sync queue
        // -------------------------------------------------------------------
        console.log('--- Test 10: Check Sync Queue GET /api/v1/sync/queue ---');
        const syncQueue = await requestJson('/sync/queue?status=all', { token });
        assert(syncQueue.status === 200, 'Sync queue returns 200');
        assert(Array.isArray(syncQueue.payload.data), 'Sync queue data is an array');
        assert(syncQueue.payload.data.length > 0, 'Sync queue has entries');
        console.log('');

        // -------------------------------------------------------------------
        // 11. Check backup
        // -------------------------------------------------------------------
        console.log('--- Test 11: Check Backup GET /api/v1/backup ---');
        const backupList = await requestJson('/backup', { token });
        assert(backupList.status === 200, 'Backup list returns 200');
        assert(Array.isArray(backupList.payload.data), 'Backup data is an array');
        console.log('');

        // -------------------------------------------------------------------
        // 12. Check daily settlement
        // -------------------------------------------------------------------
        console.log('--- Test 12: Check Daily Settlement GET /api/v1/reports/daily-settlement ---');
        const today = new Date().toISOString().split('T')[0];
        const settlement = await httpRequest(
            `${apiBase}/reports/daily-settlement?date=${today}`,
            { headers: { Authorization: `Bearer ${token}` } }
        );
        assert(settlement.status === 200, 'Daily settlement returns 200');
        assert(settlement.body.includes('日结单'), 'Daily settlement HTML contains title');
        console.log('');

        // -------------------------------------------------------------------
        // Summary
        // -------------------------------------------------------------------
        console.log('=== Results ===');
        console.log(`  Passed: ${passed}`);
        console.log(`  Failed: ${failed}`);
        console.log('');

        if (failed > 0) {
            console.error('SOME SQLITE ACCEPTANCE TESTS FAILED');
            process.exit(1);
        } else {
            console.log('ALL SQLITE ACCEPTANCE TESTS PASSED');
        }
    } catch (err) {
        console.error('\nCRITICAL ERROR:', err.message || err);
        if (err.payload) {
            console.error('Response payload:', JSON.stringify(err.payload, null, 2));
        }
        // Dump server logs on critical error
        if (serverStdout.length > 0) {
            console.error('\n=== Server stdout (last 20 lines) ===');
            serverStdout.slice(-20).forEach(l => console.error(l.trimEnd()));
        }
        if (serverStderr.length > 0) {
            console.error('\n=== Server stderr (last 20 lines) ===');
            serverStderr.slice(-20).forEach(l => console.error(l.trimEnd()));
        }
        process.exit(1);
    } finally {
        stopServer(serverContext);
        cleanupTestFiles();
    }
}

main();
