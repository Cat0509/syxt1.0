const express = require('express');
const router = express.Router();
const db = require('../db');
const { ApiResponse, asyncHandler } = require('../utils');
const { authenticate } = require('../middleware/auth');
const { requireRole, requireActiveUser, requireStoreScope } = require('../middleware/rbac');

// 获取门店营业汇总数据
router.get('/summary', authenticate, requireActiveUser, requireRole(['merchant_admin', 'store_manager', 'cashier']), requireStoreScope, asyncHandler(async (req, res) => {
    const merchant_id = req.user.merchant_id;
    // req.effectiveStoreId is provided by requireStoreScope middleware:
    // For merchant_admin it uses req.query.store_id or null (all stores)
    // For store_manager/cashier it forces req.user.store_id
    const target_store_id = req.effectiveStoreId;
    
    // Default to the start and end of current day if no range provided
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const endOfDay = startOfDay + 24 * 60 * 60 * 1000 - 1;

    const start_time = parseInt(req.query.start_time) || startOfDay;
    const end_time = parseInt(req.query.end_time) || endOfDay;

    // 基本过滤条件
    let whereClause = 'merchant_id = ? AND time >= ? AND time <= ?';
    let queryParams = [merchant_id, start_time, end_time];

    if (target_store_id) {
        whereClause += ' AND store_id = ?';
        queryParams.push(target_store_id);
    }

    try {
        // 1. 获取汇总数据 (销售总额、订单数、退款总额)
        // status 为 paid, refund_requested, partially_refunded 都算作有效订单
        const [summaryResults] = await db.query(`
            SELECT
                COUNT(CASE WHEN status IN ('paid', 'refund_requested', 'partially_refunded') THEN 1 END) as order_count,
                SUM(CASE WHEN status IN ('paid', 'refund_requested', 'partially_refunded') THEN amount ELSE 0 END) as total_sales,
                SUM(CASE WHEN status = 'refunded' THEN amount ELSE 0 END) as refund_amount
            FROM transactions
            WHERE ${whereClause}
        `, queryParams);

        // 2. 获取支付方式分布 (统计有效订单)
        const [paymentDistribution] = await db.query(`
            SELECT payment_method, SUM(amount) as amount, COUNT(1) as count
            FROM transactions 
            WHERE ${whereClause} AND status IN ('paid', 'refund_requested', 'partially_refunded')
            GROUP BY payment_method
        `, queryParams);

        const summary = summaryResults[0] || { order_count: 0, total_sales: 0, refund_amount: 0 };
        
        ApiResponse.success(res, {
            time_range: { start_time, end_time },
            store_id: target_store_id || 'all',
            summary: {
                order_count: parseInt(summary.order_count || 0),
                total_sales: parseFloat(summary.total_sales || 0),
                refund_amount: parseFloat(summary.refund_amount || 0)
            },
            payment_distribution: paymentDistribution.map(item => ({
                method: item.payment_method,
                amount: parseFloat(item.amount || 0),
                count: parseInt(item.count || 0)
            }))
        });
    } catch (err) {
        const logger = require('../logger');
        logger.error('Failed to generate report summary:', err);
        ApiResponse.error(res, 'Failed to generate report', 500);
    }
}));

// 获取销售趋势报表 (分天汇总)
router.get('/sales', authenticate, requireActiveUser, requireRole(['merchant_admin', 'store_manager']), requireStoreScope, asyncHandler(async (req, res) => {
    const merchant_id = req.user.merchant_id;
    const target_store_id = req.effectiveStoreId;
    const { start_time, end_time } = req.query;

    let whereClause = "merchant_id = ? AND status IN ('paid', 'refund_requested', 'partially_refunded')";
    let params = [merchant_id];

    if (start_time) {
        whereClause += ' AND time >= ?';
        params.push(parseInt(start_time));
    }
    if (end_time) {
        whereClause += ' AND time <= ?';
        params.push(parseInt(end_time));
    }
    if (target_store_id) {
        whereClause += ' AND store_id = ?';
        params.push(target_store_id);
    }

    // 按天进行汇总 (SQLite date() handles 13-bit millisecond timestamps)
    const sql = `
        SELECT
            date(time / 1000, 'unixepoch', 'localtime') as date,
            COUNT(1) as order_count,
            SUM(amount) as total_sales
        FROM transactions
        WHERE ${whereClause}
        GROUP BY date
        ORDER BY date ASC
    `;

    const [rows] = await db.query(sql, params);
    ApiResponse.success(res, rows);
}));

// 获取商品排行榜
router.get('/products', authenticate, requireActiveUser, requireRole(['merchant_admin', 'store_manager']), requireStoreScope, asyncHandler(async (req, res) => {
    const merchant_id = req.user.merchant_id;
    const target_store_id = req.effectiveStoreId;
    const { start_time, end_time, limit = 10 } = req.query;

    let whereClause = "t.merchant_id = ? AND t.status IN ('paid', 'refund_requested', 'partially_refunded')";
    let params = [merchant_id];

    if (start_time) {
        whereClause += ' AND t.time >= ?';
        params.push(parseInt(start_time));
    }
    if (end_time) {
        whereClause += ' AND t.time <= ?';
        params.push(parseInt(end_time));
    }
    if (target_store_id) {
        whereClause += ' AND t.store_id = ?';
        params.push(target_store_id);
    }

    const sql = `
        SELECT 
            oi.product_id, 
            oi.sku_id, 
            oi.name, 
            SUM(oi.qty) as total_qty, 
            SUM(oi.subtotal) as total_revenue
        FROM order_items oi
        JOIN transactions t ON oi.order_id = t.id
        WHERE ${whereClause}
        GROUP BY oi.product_id, oi.sku_id, oi.name
        ORDER BY total_qty DESC
        LIMIT ?
    `;
    params.push(parseInt(limit));

    const [rows] = await db.query(sql, params);
    ApiResponse.success(res, rows);
}));

// 获取员工绩效报表
router.get('/staff', authenticate, requireActiveUser, requireRole(['merchant_admin', 'store_manager']), requireStoreScope, asyncHandler(async (req, res) => {
    const merchant_id = req.user.merchant_id;
    const target_store_id = req.effectiveStoreId;
    const { start_time, end_time } = req.query;

    let whereClause = "t.merchant_id = ? AND t.status IN ('paid', 'refund_requested', 'partially_refunded')";
    let params = [merchant_id];

    if (start_time) {
        whereClause += ' AND t.time >= ?';
        params.push(parseInt(start_time));
    }
    if (end_time) {
        whereClause += ' AND t.time <= ?';
        params.push(parseInt(end_time));
    }
    if (target_store_id) {
        whereClause += ' AND t.store_id = ?';
        params.push(target_store_id);
    }

    const sql = `
        SELECT 
            t.cashier_id, 
            u.name as staff_name, 
            COUNT(t.id) as order_count, 
            SUM(t.amount) as total_sales
        FROM transactions t
        LEFT JOIN users u ON t.cashier_id = u.id
        WHERE ${whereClause}
        GROUP BY t.cashier_id, u.name
        ORDER BY total_sales DESC
    `;

    const [rows] = await db.query(sql, params);
    ApiResponse.success(res, rows);
}));

// 获取 24 小时交易趋势 (按小时汇总)
router.get('/hourly', authenticate, requireActiveUser, requireRole(['merchant_admin', 'store_manager', 'cashier']), requireStoreScope, asyncHandler(async (req, res) => {
    const merchant_id = req.user.merchant_id;
    const target_store_id = req.effectiveStoreId;
    const { start_time, end_time } = req.query;

    let whereClause = "merchant_id = ? AND status IN ('paid', 'refund_requested', 'partially_refunded')";
    let params = [merchant_id];

    if (start_time) {
        whereClause += ' AND time >= ?';
        params.push(parseInt(start_time));
    } else {
        // 默认拉取今日 0 点至今
        const d = new Date(); d.setHours(0,0,0,0);
        whereClause += ' AND time >= ?';
        params.push(d.getTime());
    }
    
    if (end_time) {
        whereClause += ' AND time <= ?';
        params.push(parseInt(end_time));
    }
    
    if (target_store_id) {
        whereClause += ' AND store_id = ?';
        params.push(target_store_id);
    }

    const sql = `
        SELECT
            CAST(strftime('%H', time / 1000, 'unixepoch', 'localtime') AS INTEGER) as hour,
            COUNT(1) as count,
            SUM(amount) as amount
        FROM transactions
        WHERE ${whereClause}
        GROUP BY hour
        ORDER BY hour ASC
    `;

    const [rows] = await db.query(sql, params);
    
    // 补齐 24 小时空缺数据 (方便前端展示)
    const fullHours = Array.from({ length: 24 }, (_, i) => {
        const row = rows.find(r => r.hour === i);
        return {
            hour: i,
            count: row ? parseInt(row.count) : 0,
            amount: row ? parseFloat(row.amount) : 0
        };
    });

    ApiResponse.success(res, fullHours);
}));

// 获取对账报表 (按门店汇总对应应收、实收、退款与差异)
router.get('/reconciliation', authenticate, requireActiveUser, requireRole(['merchant_admin', 'store_manager']), requireStoreScope, asyncHandler(async (req, res) => {
    const merchant_id = req.user.merchant_id;
    const target_store_id = req.effectiveStoreId;
    const { start_time, end_time } = req.query;

    let whereClause = 't.merchant_id = ?';
    let params = [merchant_id];

    if (start_time) {
        whereClause += ' AND t.time >= ?';
        params.push(parseInt(start_time));
    }
    if (end_time) {
        whereClause += ' AND t.time <= ?';
        params.push(parseInt(end_time));
    }
    if (target_store_id) {
        whereClause += ' AND t.store_id = ?';
        params.push(target_store_id);
    }

    const sqlRec = `
        SELECT 
            t.store_id,
            s.name as store_name,
            COUNT(DISTINCT t.id) as order_count,
            SUM(t.total) as total_receivable,
            SUM(COALESCE(p_sum.total_paid, 0)) as total_actual_received,
            SUM(CASE 
                WHEN r_sum.total_refunded IS NOT NULL THEN r_sum.total_refunded 
                WHEN t.status = 'refunded' THEN t.total 
                ELSE 0 
            END) as total_refunded_amount
        FROM transactions t
        LEFT JOIN stores s ON t.store_id = s.id
        LEFT JOIN (
            SELECT order_id, SUM(amount) as total_paid 
            FROM order_payments 
            WHERE status = 'success' 
            GROUP BY order_id
        ) p_sum ON t.id = p_sum.order_id
        LEFT JOIN (
            -- 计算已审批通过的明细退款总额
            SELECT r.order_id, SUM(ri.amount) as total_refunded
            FROM refunds r
            JOIN refund_items ri ON ri.refund_id = r.id
            WHERE r.status = 'approved'
            GROUP BY r.order_id
        ) r_sum ON t.id = r_sum.order_id
        WHERE ${whereClause}
        GROUP BY t.store_id, s.name
    `;

    const [rows] = await db.query(sqlRec, params);
    
    const formatted = rows.map(r => {
        const receivable = parseFloat(r.total_receivable || 0);
        const actual = parseFloat(r.total_actual_received || 0);
        const refunded = parseFloat(r.total_refunded_amount || 0);
        return {
            store_id: r.store_id,
            store_name: r.store_name,
            order_count: r.order_count,
            receivable,
            actual,
            refunded,
            discrepancy: actual - receivable
        };
    });

    ApiResponse.success(res, formatted);
}));

// 获取对账明细 (列出特定门店在时段内有差异的订单)
router.get('/reconciliation/orders', authenticate, requireActiveUser, requireRole(['merchant_admin', 'store_manager']), requireStoreScope, asyncHandler(async (req, res) => {
    const merchant_id = req.user.merchant_id;
    const target_store_id = req.effectiveStoreId;
    const { start_time, end_time } = req.query;

    if (!target_store_id) {
        return ApiResponse.error(res, 'store_id is required for detail view', 400);
    }

    let whereClause = 't.merchant_id = ? AND t.store_id = ?';
    let params = [merchant_id, target_store_id];

    if (start_time) {
        whereClause += ' AND t.time >= ?';
        params.push(parseInt(start_time));
    }
    if (end_time) {
        whereClause += ' AND t.time <= ?';
        params.push(parseInt(end_time));
    }

    const sqlDetails = `
        SELECT 
            t.id,
            t.time,
            t.total as receivable,
            t.status,
            COALESCE(p_sum.total_paid, 0) as actual,
            COALESCE(r_sum.total_refunded, 0) as refunded
        FROM transactions t
        LEFT JOIN (
            SELECT order_id, SUM(amount) as total_paid 
            FROM order_payments 
            WHERE status = 'success' 
            GROUP BY order_id
        ) p_sum ON t.id = p_sum.order_id
        LEFT JOIN (
            SELECT r.order_id, SUM(ri.amount) as total_refunded
            FROM refunds r
            JOIN refund_items ri ON ri.refund_id = r.id
            WHERE r.status = 'approved'
            GROUP BY r.order_id
        ) r_sum ON t.id = r_sum.order_id
        WHERE ${whereClause}
        HAVING ABS(receivable - actual) > 0.01 OR refunded > 0
        ORDER BY t.time DESC
    `;

    const [rows] = await db.query(sqlDetails, params);
    ApiResponse.success(res, rows);
}));

// 日结单 PDF 导出
router.get('/daily-settlement', authenticate, requireActiveUser, requireRole(['merchant_admin', 'store_manager']), requireStoreScope, asyncHandler(async (req, res) => {
    const merchant_id = req.user.merchant_id;
    const store_id = req.effectiveStoreId;
    const date = req.query.date || new Date().toISOString().split('T')[0];

    const dayStart = new Date(date + ' 00:00:00').getTime();
    const dayEnd = new Date(date + ' 23:59:59').getTime();

    const sqliteDb = db.getDb();

    // 1. Summary
    const summary = sqliteDb.prepare(`
        SELECT
            COUNT(*) as order_count,
            COALESCE(SUM(CAST(t.total AS REAL)), 0) as total_sales,
            COALESCE(SUM(CASE WHEN t.status = 'cancelled' THEN CAST(t.total AS REAL) ELSE 0 END), 0) as cancelled_amount,
            COALESCE(SUM(CASE WHEN t.status IN ('refund_requested', 'refunded', 'partially_refunded') THEN CAST(t.total AS REAL) ELSE 0 END), 0) as refund_amount
        FROM transactions t
        WHERE t.merchant_id = ? AND t.store_id = ? AND t.time >= ? AND t.time <= ? AND t.status IN ('paid', 'cancelled', 'refund_requested', 'partially_refunded', 'refunded')
    `).get(merchant_id, store_id, dayStart, dayEnd);

    // 2. By payment method
    const byMethod = sqliteDb.prepare(`
        SELECT payment_method, COUNT(*) as count, SUM(CAST(total AS REAL)) as amount
        FROM transactions
        WHERE merchant_id = ? AND store_id = ? AND time >= ? AND time <= ? AND status = 'paid'
        GROUP BY payment_method
    `).all(merchant_id, store_id, dayStart, dayEnd);

    // 3. By cashier
    const byCashier = sqliteDb.prepare(`
        SELECT cashier_id, COUNT(*) as count, SUM(CAST(total AS REAL)) as amount
        FROM transactions
        WHERE merchant_id = ? AND store_id = ? AND time >= ? AND time <= ? AND status = 'paid'
        GROUP BY cashier_id
    `).all(merchant_id, store_id, dayStart, dayEnd);

    // 4. Hourly breakdown
    const hourly = [];
    for (let h = 0; h < 24; h++) {
        const hStart = dayStart + h * 3600000;
        const hEnd = hStart + 3600000;
        const row = sqliteDb.prepare(`
            SELECT COUNT(*) as count, COALESCE(SUM(CAST(total AS REAL)), 0) as amount
            FROM transactions
            WHERE merchant_id = ? AND store_id = ? AND time >= ? AND time < ? AND status = 'paid'
        `).get(merchant_id, store_id, hStart, hEnd);
        if (row && (row.count > 0 || row.amount > 0)) {
            hourly.push({ hour: h, count: parseInt(row.count), amount: parseFloat(row.amount) });
        }
    }

    // Generate HTML for PDF
    const methodRows = byMethod.map(m =>
        `<tr><td>${m.payment_method || '其他'}</td><td style="text-align:right;">${m.count}</td><td style="text-align:right;">¥${parseFloat(m.amount).toFixed(2)}</td></tr>`
    ).join('');

    const cashierRows = byCashier.map(c =>
        `<tr><td>${c.cashier_id || '未知'}</td><td style="text-align:right;">${c.count}</td><td style="text-align:right;">¥${parseFloat(c.amount).toFixed(2)}</td></tr>`
    ).join('');

    const hourlyRows = hourly.map(h =>
        `<tr><td>${String(h.hour).padStart(2, '0')}:00-${String(h.hour).padStart(2, '0')}:59</td><td style="text-align:right;">${h.count}</td><td style="text-align:right;">¥${h.amount.toFixed(2)}</td></tr>`
    ).join('');

    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>日结单 - ${date}</title>
    <style>
        @page { size: A4; margin: 15mm; }
        body { font-family: 'Noto Sans SC', sans-serif; font-size: 12px; color: #333; }
        h1 { text-align: center; font-size: 20px; margin-bottom: 4px; }
        .subtitle { text-align: center; color: #666; margin-bottom: 20px; }
        .summary-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; margin-bottom: 20px; }
        .summary-card { background: #f8f9fa; border: 1px solid #e9ecef; border-radius: 6px; padding: 12px; text-align: center; }
        .summary-card .value { font-size: 20px; font-weight: bold; color: #1989fa; }
        .summary-card .label { font-size: 11px; color: #666; margin-top: 4px; }
        .summary-card.danger .value { color: #ee0a24; }
        table { width: 100%; border-collapse: collapse; margin-bottom: 16px; }
        th, td { padding: 6px 8px; border-bottom: 1px solid #e9ecef; text-align: left; }
        th { background: #f8f9fa; font-weight: 600; font-size: 11px; }
        .section-title { font-size: 14px; font-weight: 600; margin: 16px 0 8px; padding-bottom: 4px; border-bottom: 2px solid #1989fa; }
        .footer { text-align: center; color: #999; font-size: 10px; margin-top: 30px; padding-top: 10px; border-top: 1px solid #e9ecef; }
    </style></head><body>
    <h1>日 结 单</h1>
    <div class="subtitle">门店：${store_id} | 日期：${date} | 生成时间：${new Date().toLocaleString('zh-CN')}</div>

    <div class="summary-grid">
        <div class="summary-card"><div class="value">¥${parseFloat(summary.total_sales).toFixed(2)}</div><div class="label">总销售额</div></div>
        <div class="summary-card"><div class="value">${parseInt(summary.order_count)}</div><div class="label">订单总数</div></div>
        <div class="summary-card danger"><div class="value">¥${parseFloat(summary.refund_amount).toFixed(2)}</div><div class="label">退款金额</div></div>
    </div>

    <div class="section-title">支付方式分布</div>
    <table><thead><tr><th>支付方式</th><th style="text-align:right;">笔数</th><th style="text-align:right;">金额</th></tr></thead><tbody>${methodRows}</tbody></table>

    <div class="section-title">收银员业绩</div>
    <table><thead><tr><th>收银员</th><th style="text-align:right;">笔数</th><th style="text-align:right;">金额</th></tr></thead><tbody>${cashierRows}</tbody></table>

    <div class="section-title">时段分布</div>
    <table><thead><tr><th>时段</th><th style="text-align:right;">笔数</th><th style="text-align:right;">金额</th></tr></thead><tbody>${hourlyRows}</tbody></table>

    <div class="footer">如意收银系统 | 本报告由系统自动生成</div>
    </body></html>`;

    // Return HTML (the frontend can use window.print() or a PDF library)
    // For Electron, we can also use BrowserWindow.webContents.printToPDF()
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
}));

module.exports = router;
