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
    windowsHide: true
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

async function login(username, password) {
  const result = await requestJson('/auth/login', {
    method: 'POST',
    body: {
      merchantId: 'm_default',
      username,
      password
    }
  });

  return {
    username,
    token: result.payload.data.token,
    user: result.payload.data.user,
    code: result.payload.code
  };
}

async function fetchInventoryStock(token, productId, storeId = 's1') {
  const result = await requestJson(`/inventory?store_id=${encodeURIComponent(storeId)}&product_id=${encodeURIComponent(productId)}`, {
    token
  });
  const row = (result.payload.data || [])[0];
  return row ? Number(row.stock) : null;
}

async function queryInventoryMovements(refIds) {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'ruyi_pos',
    port: process.env.DB_PORT || 3306
  });

  try {
    const placeholders = refIds.map(() => '?').join(',');
    const [rows] = await connection.execute(
      `SELECT ref_id, type, qty FROM inventory_movements WHERE ref_id IN (${placeholders}) ORDER BY ref_id, created_at ASC`,
      refIds
    );
    return rows;
  } finally {
    await connection.end();
  }
}

function makeClientTxId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
}

async function main() {
  const serverContext = await ensureServer();

  try {
    const admin = await login('admin', 'admin');
    const manager = await login('manager1', '123456');
    const cashier = await login('cashier1', '123456');

    const now = Date.now();
    const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;

    const summary = await requestJson(`/reports/summary?store_id=s1&start_time=${sevenDaysAgo}&end_time=${now}`, {
      token: admin.token
    });
    const sales = await requestJson(`/reports/sales?start_time=${sevenDaysAgo}&end_time=${now}`, {
      token: manager.token
    });
    const productsReport = await requestJson(`/reports/products?start_time=${sevenDaysAgo}&end_time=${now}`, {
      token: manager.token
    });
    const staff = await requestJson(`/reports/staff?start_time=${sevenDaysAgo}&end_time=${now}`, {
      token: manager.token
    });
    const hourly = await requestJson(`/reports/hourly?start_time=${sevenDaysAgo}&end_time=${now}`, {
      token: cashier.token
    });

    const products = (await requestJson('/products', { token: cashier.token })).payload.data || [];
    const inventory = (await requestJson('/inventory?store_id=s1', { token: cashier.token })).payload.data || [];

    const candidate =
      inventory.find((row) => (!row.sku_id || row.sku_id === '') && Number(row.stock) >= 4) ||
      inventory.find((row) => Number(row.stock) >= 4);

    if (!candidate) {
      throw new Error('No inventory item with sufficient stock for Phase 3 smoke test');
    }

    const product = products.find((item) => item.id === candidate.product_id);
    if (!product) {
      throw new Error(`Product not found for inventory item ${candidate.product_id}`);
    }

    const sku = candidate.sku_id ? (product.skus || []).find((item) => item.id === candidate.sku_id) : null;
    const itemPrice = Number(sku?.price ?? product.price);
    const itemName = sku ? `${product.name} (${sku.specName})` : product.name;
    const item = {
      product_id: candidate.product_id,
      sku_id: candidate.sku_id || null,
      name: itemName,
      price: itemPrice,
      qty: 1
    };

    let managerCrossStoreStatus = 200;
    try {
      await requestJson('/refunds?store_id=s2', {
        token: manager.token,
        expectedStatus: 200
      });
    } catch (error) {
      managerCrossStoreStatus = error.status || 500;
    }

    const managerRefunds = await requestJson('/refunds', { token: manager.token });

    const scanOrder = await requestJson('/orders', {
      method: 'POST',
      token: cashier.token,
      body: {
        client_tx_id: makeClientTxId('phase3_scan'),
        store_id: 's1',
        total: itemPrice,
        amount: itemPrice,
        payment_method: 'scan',
        payment: { method: 'scan', received: itemPrice, change: 0 },
        items: [item]
      }
    });
    const scanOrderId = scanOrder.payload.data.order_id;
    const scanBefore = (await requestJson(`/orders?order_id=${encodeURIComponent(scanOrderId)}`, {
      token: cashier.token
    })).payload.data[0];

    const scanPayment = await requestJson('/payments/create', {
      method: 'POST',
      token: cashier.token,
      body: {
        order_id: scanOrderId,
        amount: itemPrice,
        method: 'scan'
      }
    });

    await sleep(2200);

    const scanAfter = (await requestJson(`/orders?order_id=${encodeURIComponent(scanOrderId)}`, {
      token: cashier.token
    })).payload.data[0];

    const manualCallback = await requestJson('/payments/callback', {
      method: 'POST',
      body: {
        order_id: scanOrderId,
        status: 'success',
        payment_id: makeClientTxId('manual_callback'),
        method: 'scan'
      }
    });

    const cashOrder = await requestJson('/orders', {
      method: 'POST',
      token: cashier.token,
      body: {
        client_tx_id: makeClientTxId('phase3_cash'),
        store_id: 's1',
        total: itemPrice,
        amount: itemPrice,
        payment_method: 'cash',
        payment: { method: 'cash', received: itemPrice + 5, change: 5 },
        items: [item]
      }
    });
    const cashOrderId = cashOrder.payload.data.order_id;
    const cashBefore = (await requestJson(`/orders?order_id=${encodeURIComponent(cashOrderId)}`, {
      token: cashier.token
    })).payload.data[0];

    const cashPayment = await requestJson('/payments/create', {
      method: 'POST',
      token: cashier.token,
      body: {
        order_id: cashOrderId,
        amount: itemPrice,
        method: 'cash'
      }
    });

    const cashAfter = (await requestJson(`/orders?order_id=${encodeURIComponent(cashOrderId)}`, {
      token: cashier.token
    })).payload.data[0];

    const stockAfterCashSale = await fetchInventoryStock(cashier.token, item.product_id);

    await requestJson('/refunds', {
      method: 'POST',
      token: cashier.token,
      body: {
        order_id: cashOrderId,
        reason: 'phase3 acceptance refund'
      }
    });

    const requestedRefunds = await requestJson('/refunds?status=requested', {
      token: manager.token
    });
    const refundRow = (requestedRefunds.payload.data || []).find((entry) => entry.order_id === cashOrderId);
    if (!refundRow) {
      throw new Error('Refund request not found in manager list');
    }

    await requestJson(`/refunds/${refundRow.id}/approve`, {
      method: 'PATCH',
      token: manager.token
    });

    const refundedCashOrder = (await requestJson(`/orders?order_id=${encodeURIComponent(cashOrderId)}`, {
      token: cashier.token
    })).payload.data[0];

    const stockAfterRefund = await fetchInventoryStock(cashier.token, item.product_id);

    const replayPayload = {
      orders: [
        {
          client_tx_id: makeClientTxId('phase3_replay'),
          store_id: 's1',
          total: itemPrice,
          amount: itemPrice,
          payment_method: 'cash',
          payment: { method: 'cash', received: itemPrice, change: 0 },
          items: [item]
        }
      ]
    };

    const replay = await requestJson('/orders/replay', {
      method: 'POST',
      token: cashier.token,
      body: replayPayload
    });
    const replayResult = replay.payload.data.results[0];

    const replayDuplicate = await requestJson('/orders/replay', {
      method: 'POST',
      token: cashier.token,
      body: replayPayload
    });
    const replayDuplicateResult = replayDuplicate.payload.data.results[0];

    const stockAfterReplay = await fetchInventoryStock(cashier.token, item.product_id);

    const replayFailure = await requestJson('/orders/replay', {
      method: 'POST',
      token: cashier.token,
      body: {
        orders: [
          {
            client_tx_id: makeClientTxId('phase3_replay_fail'),
            store_id: 's1',
            total: itemPrice * (stockAfterReplay + 9999),
            amount: itemPrice * (stockAfterReplay + 9999),
            payment_method: 'cash',
            payment: { method: 'cash', received: itemPrice * (stockAfterReplay + 9999), change: 0 },
            items: [
              {
                ...item,
                qty: stockAfterReplay + 9999
              }
            ]
          }
        ]
      }
    });
    const replayFailureResult = replayFailure.payload.data.results[0];

    const stockAfterReplayFailure = await fetchInventoryStock(cashier.token, item.product_id);

    await requestJson('/inventory/adjust', {
      method: 'POST',
      token: manager.token,
      body: {
        store_id: 's1',
        product_id: item.product_id,
        sku_id: item.sku_id,
        type: 'adjust',
        qty: 1,
        reason: 'phase3 acceptance restore replay stock'
      }
    });

    const stockAfterRestore = await fetchInventoryStock(cashier.token, item.product_id);

    const movements = await queryInventoryMovements([scanOrderId, cashOrderId, replayResult.order_id]);

    const movementSummary = {
      [scanOrderId]: movements.filter((itemRow) => itemRow.ref_id === scanOrderId).map((itemRow) => itemRow.type),
      [cashOrderId]: movements.filter((itemRow) => itemRow.ref_id === cashOrderId).map((itemRow) => itemRow.type),
      [replayResult.order_id]: movements.filter((itemRow) => itemRow.ref_id === replayResult.order_id).map((itemRow) => itemRow.type)
    };

    const checks = {
      admin_login_ok: admin.code === 200,
      manager_login_ok: manager.code === 200,
      cashier_login_ok: cashier.code === 200,
      reports_summary_ok: summary.payload.code === 200,
      reports_sales_ok: sales.payload.code === 200,
      reports_products_ok: productsReport.payload.code === 200,
      reports_staff_ok: staff.payload.code === 200,
      reports_hourly_full_24: (hourly.payload.data || []).length === 24,
      orders_return_items: Array.isArray(scanBefore.items) && scanBefore.items.length > 0,
      refund_scope_enforced: managerCrossStoreStatus === 403,
      scan_order_pending_before_payment: scanBefore.status === 'pending' && scanBefore.payment_status === 'unpaid',
      scan_payment_auto_callback: scanPayment.payload.data.callback_mode === 'server_auto_mock',
      scan_order_paid_after_callback: scanAfter.status === 'paid' && scanAfter.payment_status === 'paid',
      manual_callback_idempotent: manualCallback.payload.data.already_paid === true,
      cash_order_pending_before_payment: cashBefore.status === 'pending' && cashBefore.payment_status === 'unpaid',
      cash_payment_immediate: cashPayment.payload.data.callback_mode === 'cash_immediate',
      cash_order_paid_after_payment: cashAfter.status === 'paid' && cashAfter.payment_status === 'paid',
      refund_approval_updates_order: refundedCashOrder.status === 'refunded' && refundedCashOrder.payment_status === 'refunded',
      refund_replenishes_inventory: stockAfterRefund === stockAfterCashSale + 1,
      replay_accepts_batch: replayResult.code === 200,
      replay_duplicate_returns_409: replayDuplicateResult.code === 409,
      replay_stock_failure_returns_400: replayFailureResult.code === 400,
      replay_failure_keeps_inventory_unchanged: stockAfterReplayFailure === stockAfterReplay,
      replay_restore_backfills_inventory: stockAfterRestore === stockAfterRefund,
      inventory_sale_movements_recorded:
        movementSummary[scanOrderId].includes('sale') &&
        movementSummary[cashOrderId].includes('sale') &&
        movementSummary[replayResult.order_id].includes('sale'),
      inventory_refund_movement_recorded: movementSummary[cashOrderId].includes('refund')
    };

    const failedChecks = Object.entries(checks)
      .filter(([, passed]) => !passed)
      .map(([name]) => name);

    const result = {
      date: new Date().toISOString(),
      base_url: baseUrl,
      product_under_test: {
        product_id: item.product_id,
        sku_id: item.sku_id,
        name: item.name,
        price: item.price
      },
      artifacts: {
        scan_order_id: scanOrderId,
        cash_order_id: cashOrderId,
        refund_id: refundRow.id,
        replay_order_id: replayResult.order_id
      },
      metrics: {
        stock_before: Number(candidate.stock),
        stock_after_cash_sale: stockAfterCashSale,
        stock_after_refund: stockAfterRefund,
        stock_after_replay: stockAfterReplay,
        stock_after_replay_failure: stockAfterReplayFailure,
        stock_after_restore: stockAfterRestore,
        manager_refunds_visible_count: (managerRefunds.payload.data || []).length,
        report_sales_rows: (sales.payload.data || []).length,
        report_products_rows: (productsReport.payload.data || []).length,
        report_staff_rows: (staff.payload.data || []).length,
        report_hourly_rows: (hourly.payload.data || []).length
      },
      movement_summary: movementSummary,
      checks,
      failed_checks: failedChecks
    };

    console.log(JSON.stringify(result, null, 2));

    if (failedChecks.length > 0) {
      process.exitCode = 1;
    }
  } finally {
    stopServer(serverContext);
  }
}

main().catch((error) => {
  const output = {
    error: error.message,
    status: error.status || null,
    payload: error.payload || null
  };
  console.error(JSON.stringify(output, null, 2));
  process.exit(1);
});
