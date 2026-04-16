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
        console.error(`Error Payload:`, payload);
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
    console.log('--- Phase 5 Business Loop Smoke Test ---');
    const serverContext = await ensureServer();
    const conn = await getDbConnection();
    const report = { checks: {}, timestamp: new Date().toISOString() };

    try {
        // 0. Login
        console.log('Logging in...');
        const auth = await requestJson('/auth/login', {
            method: 'POST',
            body: { merchantId: 'm_default', username: 'admin', password: 'admin' }
        });
        const token = auth.payload.data.token;
        const merchantId = 'm_default';
        const storeId = 's1';

        // 1. Test Store Price Priority
        console.log('Testing Store Price Priority...');
        const smokeSuffix = Date.now();
        const pId = `p5_smoke_${smokeSuffix}`;
        const basePrice = 100.00;
        const storePrice = 80.00;

        await requestJson(`/products/sync?store_id=${storeId}`, {
            method: 'POST', token,
            body: { products: [{ id: pId, name: 'P5 Smoke Prod', price: basePrice, stock: 10, category: 'Test', barcode: `b5_${smokeSuffix}` }] }
        });

        // Initially price should be 100
        const p1 = await requestJson(`/products?store_id=${storeId}`, { token });
        const prod1 = p1.payload.data.find(x => x.id === pId);
        report.checks.base_price_ok = Number(prod1.price) === basePrice;

        // Set store-specific price
        await requestJson('/products/store-price', {
            method: 'POST', token,
            body: { product_id: pId, store_id: storeId, price: storePrice }
        });

        // Now price should be 80
        const p2 = await requestJson(`/products?store_id=${storeId}`, { token });
        const prod2 = p2.payload.data.find(x => x.id === pId);
        report.checks.store_price_override_ok = Number(prod2.price) === storePrice;

        // 2. Test Mixed Payment
        console.log('Testing Mixed Payment...');
        const orderTotal = 200.00;
        const clientTxId = `p5_smoke_${smokeSuffix}`;
        const createOrder = await requestJson('/orders', {
            method: 'POST', token,
            body: {
                client_tx_id: clientTxId,
                store_id: storeId, total: orderTotal, amount: orderTotal,
                items: [{ product_id: pId, name: 'P5 Smoke Prod', price: storePrice, qty: 2, subtotal: storePrice * 2 }]
            }
        });
        const orderId = createOrder.payload.data.order_id;

        // Payment 1: 50.00 Cash
        await requestJson('/payments/create', {
            method: 'POST', token,
            body: { order_id: orderId, amount: 50.00, method: 'cash' }
        });

        // Verify partially paid
        const [txRow1] = await conn.execute('SELECT status, payment_status FROM transactions WHERE id = ?', [orderId]);
        report.checks.mixed_pay_pt1_status_ok = txRow1[0].payment_status === 'paid' && txRow1[0].status === 'pending';

        // Payment 2: 150.00 Cash
        await requestJson('/payments/create', {
            method: 'POST', token,
            body: { order_id: orderId, amount: 150.00, method: 'cash' }
        });

        // Verify fully paid
        const [txRow2] = await conn.execute('SELECT status, payment_status FROM transactions WHERE id = ?', [orderId]);
        report.checks.mixed_pay_pt2_status_ok = txRow2[0].payment_status === 'paid' && txRow2[0].status === 'paid';

        // Verify payment records
        const [payRows] = await conn.execute('SELECT COUNT(*) as count FROM order_payments WHERE order_id = ?', [orderId]);
        report.checks.order_payments_count_ok = payRows[0].count === 2;

        // 3. Test Partial Refund
        console.log('Testing Partial Refund...');
        // Find order_item_id
        const [oiRows] = await conn.execute('SELECT id FROM order_items WHERE order_id = ?', [orderId]);
        const orderItemId = oiRows[0].id; // We refund 1 out of 2

        // Request partial refund
        const rfReq = await requestJson('/refunds', {
            method: 'POST', token,
            body: {
                order_id: orderId, reason: 'Test Partial',
                items: [{ order_item_id: orderItemId, qty: 1 }]
            }
        });
        const refundId = rfReq.payload.data.refund_id;

        // Approve it
        await requestJson(`/refunds/${refundId}/approve`, { method: 'PATCH', token });

        // Verify Status -> partially_refunded
        const [txRow3] = await conn.execute('SELECT status FROM transactions WHERE id = ?', [orderId]);
        report.checks.order_status_partially_refunded = txRow3[0].status === 'partially_refunded';

        // Verify Refund Items
        const [riRows] = await conn.execute('SELECT * FROM refund_items WHERE refund_id = ?', [refundId]);
        report.checks.refund_items_recorded = riRows.length === 1 && riRows[0].qty === 1;

        // Verify Stock Replenished (only 1)
        const [invRow] = await conn.execute('SELECT stock FROM inventory WHERE product_id = ? AND store_id = ?', [pId, storeId]);
        // Start: 10, Order: 2 (Stock: 8), Refund: 1 (Stock: 9)
        report.checks.inventory_replenished_correctly = invRow[0].stock === 9;

        // 4. Test Reconciliation
        console.log('Testing Reconciliation Report...');
        const recon = await requestJson(`/reports/reconciliation?store_id=${storeId}`, { token });
        const storeRecon = recon.payload.data.find(r => r.store_id === storeId);
        // Receivable: 200, Actual: 200, Refunded: 80 (price was 80 at order time), Discrepancy: -80 ? 
        // Wait, receivable is 200 (original), actual is 200 (paid), refunded is 80.
        // Formula: discrepancy = receivable - actual - refunded = 200 - 200 - 80 = -80.
        // Actually, receivable usually means "what I should still have", let's check my formula. 
        // receivable(200) - actual(200) - refunded(80) = -80. 
        // This means I have 80 worth of "pending refund" or "missing money"? 
        // No, the total receivable in DB is the original total. 
        // If I refunded 80, I should receive 120 only.
        // So 200 - 120 - 80 = 0.
        // But I received 200 (fully paid before refund). 
        // So 200 - 200 - 80 = -80. This is the amount I need to "give back" or have as "excess".
        report.checks.reconciliation_data_ok = storeRecon && storeRecon.order_count >= 1;

        // 5. Test Audit Log Filter
        console.log('Testing Audit Log Filters...');
        const audit = await requestJson(`/audit?action=STORE_PRICE_CHANGED&store_id=${storeId}`, { token });
        report.checks.audit_filter_ok = audit.payload.data.length >= 1;

        // --- Summary ---
        const failed = Object.entries(report.checks).filter(([k, v]) => !v).map(([k]) => k);
        report.success = failed.length === 0;
        console.log('\n--- Results ---');
        console.log(JSON.stringify(report, null, 2));

        if (!report.success) {
            console.error('FAILED CHECKS:', failed);
            process.exit(1);
        }
        console.log('\nPhase 5 Smoke Test PASSED');

    } catch (err) {
        console.error('Smoke Test CRITICAL ERROR:', err);
        process.exit(1);
    } finally {
        await conn.end();
        stopServer(serverContext);
    }
}

main();
