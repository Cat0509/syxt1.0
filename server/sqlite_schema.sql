-- ============================================================
-- Ruyi POS Multi-Tenant SaaS - SQLite Schema
-- Converted from mysql_schema.sql + migration 005 + sync_queue
-- ============================================================

PRAGMA journal_mode = WAL;

-- ============================================================
-- 0. _migrations (system internal)
-- ============================================================
CREATE TABLE IF NOT EXISTS _migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    executed_at INTEGER DEFAULT (strftime('%s', 'now'))
);

-- ============================================================
-- 1. merchants (SaaS Tenants)
-- ============================================================
CREATE TABLE IF NOT EXISTS merchants (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    contact_phone TEXT,
    status TEXT DEFAULT 'active' CHECK(status IN ('active', 'suspended', 'expired')),
    created_at INTEGER
);

-- ============================================================
-- 2. stores
-- ============================================================
CREATE TABLE IF NOT EXISTS stores (
    id TEXT PRIMARY KEY,
    merchant_id TEXT NOT NULL,
    name TEXT NOT NULL,
    address TEXT,
    created_at INTEGER
);

-- ============================================================
-- 3. users
-- ============================================================
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    merchant_id TEXT NOT NULL,
    username TEXT NOT NULL,
    password_hash TEXT,
    password TEXT,
    name TEXT,
    role TEXT DEFAULT 'cashier' CHECK(role IN ('merchant_admin', 'store_manager', 'cashier')),
    status TEXT DEFAULT 'active' CHECK(status IN ('active', 'disabled')),
    must_change_password INTEGER DEFAULT 0,
    last_login_at INTEGER,
    created_by TEXT,
    store_id TEXT,
    created_at INTEGER,
    updated_at INTEGER,
    fail_count INTEGER DEFAULT 0,
    lock_until INTEGER DEFAULT 0,
    UNIQUE(merchant_id, username)
);

-- ============================================================
-- 4. products
-- ============================================================
CREATE TABLE IF NOT EXISTS products (
    id TEXT PRIMARY KEY,
    merchant_id TEXT NOT NULL,
    name TEXT NOT NULL,
    price TEXT NOT NULL,
    category TEXT,
    barcode TEXT,
    stock INTEGER DEFAULT 0,
    store_id TEXT,
    updated_at INTEGER
);

-- ============================================================
-- 5. skus
-- ============================================================
CREATE TABLE IF NOT EXISTS skus (
    id TEXT PRIMARY KEY,
    merchant_id TEXT NOT NULL,
    product_id TEXT NOT NULL,
    specName TEXT,
    price TEXT,
    stock INTEGER,
    barcode TEXT,
    store_id TEXT
);

-- ============================================================
-- 6. devices
-- ============================================================
CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY,
    name TEXT,
    store_id TEXT,
    last_login_at INTEGER,
    status TEXT DEFAULT 'active' CHECK(status IN ('active', 'inactive')),
    created_at INTEGER
);

-- ============================================================
-- 7. transactions (Orders)
-- ============================================================
CREATE TABLE IF NOT EXISTS transactions (
    id TEXT PRIMARY KEY,
    merchant_id TEXT NOT NULL,
    time INTEGER NOT NULL,
    items TEXT,
    total TEXT,
    amount TEXT,
    payment TEXT,
    processed_by TEXT,
    store_id TEXT,
    updated_at INTEGER,
    order_no TEXT UNIQUE,
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'paid', 'cancelled', 'refund_requested', 'refunded', 'partially_refunded')),
    payment_status TEXT DEFAULT 'unpaid' CHECK(payment_status IN ('unpaid', 'paid', 'refunded')),
    payment_method TEXT CHECK(payment_method IN ('cash', 'scan', 'card')),
    cashier_id TEXT,
    device_id TEXT,
    client_tx_id TEXT UNIQUE,
    business_date INTEGER,
    offline_cash_collected TEXT DEFAULT '0',
    offline_payment_pending INTEGER DEFAULT 0,
    offline_id TEXT UNIQUE
);

-- ============================================================
-- 8. order_items
-- ============================================================
CREATE TABLE IF NOT EXISTS order_items (
    id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL,
    product_id TEXT NOT NULL,
    sku_id TEXT,
    name TEXT NOT NULL,
    price TEXT NOT NULL,
    qty INTEGER NOT NULL,
    subtotal TEXT NOT NULL,
    price_snapshot TEXT
);

-- ============================================================
-- 9. inventory_movements
-- ============================================================
CREATE TABLE IF NOT EXISTS inventory_movements (
    id TEXT PRIMARY KEY,
    merchant_id TEXT NOT NULL,
    store_id TEXT NOT NULL,
    product_id TEXT NOT NULL,
    sku_id TEXT,
    type TEXT NOT NULL CHECK(type IN ('sale', 'refund', 'purchase', 'adjust', 'transfer_in', 'transfer_out', 'cancel_restore')),
    qty INTEGER NOT NULL,
    ref_id TEXT,
    created_at INTEGER NOT NULL
);

-- ============================================================
-- 10. refunds
-- ============================================================
CREATE TABLE IF NOT EXISTS refunds (
    id TEXT PRIMARY KEY,
    merchant_id TEXT NOT NULL,
    order_id TEXT NOT NULL,
    status TEXT DEFAULT 'requested' CHECK(status IN ('requested', 'approved', 'rejected', 'refunded')),
    reason TEXT,
    requested_by TEXT,
    approved_by TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER
);

-- ============================================================
-- 11. inventory
-- ============================================================
CREATE TABLE IF NOT EXISTS inventory (
    id TEXT PRIMARY KEY,
    merchant_id TEXT NOT NULL,
    store_id TEXT NOT NULL,
    product_id TEXT NOT NULL,
    sku_id TEXT DEFAULT '',
    stock INTEGER DEFAULT 0,
    updated_at INTEGER,
    UNIQUE(store_id, product_id, sku_id)
);

-- ============================================================
-- 12. audit_logs
-- ============================================================
CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    merchant_id TEXT NOT NULL,
    action TEXT,
    details TEXT,
    time INTEGER,
    store_id TEXT,
    user_id TEXT,
    username TEXT
);

-- ============================================================
-- 13. order_payments (from migration 005)
-- ============================================================
CREATE TABLE IF NOT EXISTS order_payments (
    id TEXT PRIMARY KEY,
    merchant_id TEXT,
    store_id TEXT,
    order_id TEXT,
    method TEXT CHECK(method IN ('cash', 'scan', 'card', 'other', 'wechat', 'alipay')),
    amount TEXT,
    status TEXT CHECK(status IN ('pending', 'success', 'failed', 'refunded')),
    transaction_ref TEXT,
    created_at INTEGER
);

-- ============================================================
-- 14. refund_items (from migration 005)
-- ============================================================
CREATE TABLE IF NOT EXISTS refund_items (
    id TEXT PRIMARY KEY,
    refund_id TEXT,
    order_item_id TEXT,
    product_id TEXT,
    sku_id TEXT,
    qty INTEGER,
    amount TEXT,
    reason TEXT
);

-- ============================================================
-- 15. store_prices (from migration 005)
-- ============================================================
CREATE TABLE IF NOT EXISTS store_prices (
    id TEXT PRIMARY KEY,
    merchant_id TEXT,
    store_id TEXT,
    product_id TEXT,
    sku_id TEXT DEFAULT '',
    price TEXT,
    updated_at INTEGER,
    UNIQUE(store_id, product_id, sku_id)
);

-- ============================================================
-- 16. sync_queue (offline-first sync)
-- ============================================================
CREATE TABLE IF NOT EXISTS sync_queue (
    id TEXT PRIMARY KEY,
    merchant_id TEXT,
    store_id TEXT,
    entity_type TEXT CHECK(entity_type IN ('order', 'payment', 'refund', 'inventory_movement', 'audit_log')),
    entity_id TEXT,
    operation TEXT DEFAULT 'create',
    payload TEXT,
    sync_status TEXT DEFAULT 'pending' CHECK(sync_status IN ('pending', 'synced', 'failed')),
    attempts INTEGER DEFAULT 0,
    last_attempt_at INTEGER,
    created_at INTEGER,
    synced_at INTEGER
);

-- ============================================================
-- Indexes (created separately after tables)
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_skus_store_product ON skus(store_id, product_id);
CREATE INDEX IF NOT EXISTS idx_transactions_merchant_time ON transactions(merchant_id, time);
CREATE INDEX IF NOT EXISTS idx_transactions_store_status_time ON transactions(store_id, status, time);
CREATE INDEX IF NOT EXISTS idx_transactions_payment_time ON transactions(payment_method, time);
CREATE INDEX IF NOT EXISTS idx_order_items_product_id ON order_items(product_id);
CREATE INDEX IF NOT EXISTS idx_order_items_sku_id ON order_items(sku_id);
CREATE INDEX IF NOT EXISTS idx_refunds_status ON refunds(status);
CREATE INDEX IF NOT EXISTS idx_order_payments_order_id ON order_payments(order_id);
CREATE INDEX IF NOT EXISTS idx_refund_items_refund_id ON refund_items(refund_id);
CREATE INDEX IF NOT EXISTS idx_sync_queue_sync_status ON sync_queue(sync_status);
CREATE INDEX IF NOT EXISTS idx_sync_queue_entity ON sync_queue(entity_type, entity_id);

-- ============================================================
-- Seed Data
-- ============================================================
-- 2.0 门店端：不再预置种子数据，首次启动必须走初始化向导。
-- 旧版 m_default/admin 等种子数据已移除。
-- ============================================================
PRAGMA foreign_keys = ON;
