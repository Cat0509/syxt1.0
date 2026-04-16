-- Ruyi POS Multi-Tenant SaaS MySQL Schema
-- Supports True Multi-merchant Data Isolation
-- Database selection is handled by the migration runner.

-- 0. Merchants Table (SaaS Tenants)
CREATE TABLE IF NOT EXISTS merchants (
    id VARCHAR(50) PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    contact_phone VARCHAR(20),
    status ENUM('active', 'suspended', 'expired') DEFAULT 'active',
    created_at BIGINT
);

-- 1. Stores Table (One merchant can have multiple stores)
CREATE TABLE IF NOT EXISTS stores (
    id VARCHAR(50) PRIMARY KEY,
    merchant_id VARCHAR(50) NOT NULL,
    name VARCHAR(100) NOT NULL,
    address VARCHAR(255),
    created_at BIGINT,
    FOREIGN KEY (merchant_id) REFERENCES merchants(id) ON DELETE CASCADE
);

-- 2. Users Table (Employees for a merchant)
CREATE TABLE IF NOT EXISTS users (
    id VARCHAR(50) PRIMARY KEY,
    merchant_id VARCHAR(50) NOT NULL,
    username VARCHAR(50) NOT NULL,
    password_hash VARCHAR(255),
    password VARCHAR(255), -- Deprecated, for migration only
    name VARCHAR(100),
    role ENUM('merchant_admin', 'store_manager', 'cashier') DEFAULT 'cashier',
    status ENUM('active', 'disabled') DEFAULT 'active',
    must_change_password BOOLEAN DEFAULT FALSE,
    last_login_at BIGINT,
    created_by VARCHAR(50),
    store_id VARCHAR(50),
    created_at BIGINT,
    updated_at BIGINT,
    UNIQUE KEY uniq_merchant_username (merchant_id, username),
    FOREIGN KEY (merchant_id) REFERENCES merchants(id) ON DELETE CASCADE,
    FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE SET NULL
);

-- 3. Products Table
CREATE TABLE IF NOT EXISTS products (
    id VARCHAR(50) PRIMARY KEY,
    merchant_id VARCHAR(50) NOT NULL,
    name VARCHAR(100) NOT NULL,
    price DECIMAL(10, 2) NOT NULL,
    category VARCHAR(50),
    barcode VARCHAR(50),
    stock INT DEFAULT 0, -- Deprecated in Phase 3, move to inventory table
    store_id VARCHAR(50), -- Deprecated in Phase 3, move to inventory table
    updated_at BIGINT,
    FOREIGN KEY (merchant_id) REFERENCES merchants(id) ON DELETE CASCADE,
    FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE SET NULL
);

-- 4. SKUs Table (Multi-spec)
CREATE TABLE IF NOT EXISTS skus (
    id VARCHAR(50) PRIMARY KEY,
    merchant_id VARCHAR(50) NOT NULL,
    product_id VARCHAR(50) NOT NULL,
    specName VARCHAR(50),
    price DECIMAL(10, 2),
    stock INT, -- Deprecated in Phase 3, move to inventory table
    barcode VARCHAR(50),
    store_id VARCHAR(50), -- Deprecated in Phase 3, move to inventory table
    FOREIGN KEY (merchant_id) REFERENCES merchants(id) ON DELETE CASCADE,
    FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE SET NULL,
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
    INDEX idx_store_product (store_id, product_id)
);

-- 5. Transactions Table (Orders)
CREATE TABLE IF NOT EXISTS transactions (
    id VARCHAR(50) PRIMARY KEY,
    merchant_id VARCHAR(50) NOT NULL,
    time BIGINT NOT NULL,
    items TEXT, -- JSON structure
    total DECIMAL(10, 2),
    amount DECIMAL(10, 2),
    payment TEXT, -- JSON structure (method, received, change)
    processed_by VARCHAR(100),
    store_id VARCHAR(50),
    updated_at BIGINT,
    order_no VARCHAR(100) UNIQUE,
    status ENUM('pending', 'paid', 'cancelled', 'refund_requested', 'refunded') DEFAULT 'pending',
    payment_status ENUM('unpaid', 'paid', 'refunded') DEFAULT 'unpaid',
    payment_method ENUM('cash', 'scan', 'card'),
    cashier_id VARCHAR(50),
    client_tx_id VARCHAR(100) UNIQUE,
    FOREIGN KEY (merchant_id) REFERENCES merchants(id) ON DELETE CASCADE,
    FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE SET NULL,
    FOREIGN KEY (cashier_id) REFERENCES users(id) ON DELETE SET NULL,
    INDEX idx_merchant_time (merchant_id, time),
    INDEX idx_store_status_time (store_id, status, time),
    INDEX idx_payment_time (payment_method, time)
);

-- 6. Order Items Table
CREATE TABLE IF NOT EXISTS order_items (
    id VARCHAR(50) PRIMARY KEY,
    order_id VARCHAR(50) NOT NULL,
    product_id VARCHAR(50) NOT NULL,
    sku_id VARCHAR(50),
    name VARCHAR(100) NOT NULL,
    price DECIMAL(10, 2) NOT NULL,
    qty INT NOT NULL,
    subtotal DECIMAL(10, 2) NOT NULL,
    FOREIGN KEY (order_id) REFERENCES transactions(id) ON DELETE CASCADE,
    INDEX idx_product_id (product_id),
    INDEX idx_sku_id (sku_id)
);

-- 7. Inventory Movements Table
CREATE TABLE IF NOT EXISTS inventory_movements (
    id VARCHAR(50) PRIMARY KEY,
    merchant_id VARCHAR(50) NOT NULL,
    store_id VARCHAR(50) NOT NULL,
    product_id VARCHAR(50) NOT NULL,
    sku_id VARCHAR(50),
    type ENUM('sale', 'refund', 'purchase', 'adjust', 'transfer_in', 'transfer_out') NOT NULL,
    qty INT NOT NULL,
    ref_id VARCHAR(50),
    created_at BIGINT NOT NULL,
    FOREIGN KEY (merchant_id) REFERENCES merchants(id) ON DELETE CASCADE,
    FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE
);

-- 8. Refunds Table
CREATE TABLE IF NOT EXISTS refunds (
    id VARCHAR(50) PRIMARY KEY,
    merchant_id VARCHAR(50) NOT NULL,
    order_id VARCHAR(50) NOT NULL,
    status ENUM('requested', 'approved', 'rejected', 'refunded') DEFAULT 'requested',
    reason VARCHAR(255),
    requested_by VARCHAR(50),
    approved_by VARCHAR(50),
    created_at BIGINT NOT NULL,
    updated_at BIGINT,
    FOREIGN KEY (merchant_id) REFERENCES merchants(id) ON DELETE CASCADE,
    FOREIGN KEY (order_id) REFERENCES transactions(id) ON DELETE CASCADE,
    FOREIGN KEY (requested_by) REFERENCES users(id) ON DELETE SET NULL,
    FOREIGN KEY (approved_by) REFERENCES users(id) ON DELETE SET NULL,
    INDEX idx_status (status)
);

-- 9. Inventory Table (Phase 3 New)
CREATE TABLE IF NOT EXISTS inventory (
    id VARCHAR(50) PRIMARY KEY,
    merchant_id VARCHAR(50) NOT NULL,
    store_id VARCHAR(50) NOT NULL,
    product_id VARCHAR(50) NOT NULL,
    sku_id VARCHAR(50) DEFAULT '', -- Use empty string for simple products to avoid NULL unique index issues
    stock INT DEFAULT 0,
    updated_at BIGINT,
    UNIQUE KEY uniq_store_item (store_id, product_id, sku_id),
    FOREIGN KEY (merchant_id) REFERENCES merchants(id) ON DELETE CASCADE,
    FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE
);

-- 10. Audit Logs
CREATE TABLE IF NOT EXISTS audit_logs (
    id INT AUTO_INCREMENT PRIMARY KEY,
    merchant_id VARCHAR(50) NOT NULL,
    action VARCHAR(50),
    details TEXT,
    time BIGINT,
    store_id VARCHAR(50),
    FOREIGN KEY (merchant_id) REFERENCES merchants(id) ON DELETE CASCADE,
    FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE SET NULL
);

-- Initial Data
-- Create a default SaaS merchant first
INSERT IGNORE INTO merchants (id, name, created_at) VALUES ('m_default', '测试加盟店', 1675718400000);

-- Insert stores bound to merchant
INSERT IGNORE INTO stores (id, merchant_id, name, created_at) VALUES ('s1', 'm_default', '旗舰店', 1675718400000);
INSERT IGNORE INTO stores (id, merchant_id, name, created_at) VALUES ('s2', 'm_default', '分店01', 1675718400000);
INSERT IGNORE INTO stores (id, merchant_id, name, created_at) VALUES ('s3', 'm_default', '分店02', 1675718400000);

-- Default Users for testing Phase 1 Roles
INSERT IGNORE INTO users (id, merchant_id, username, password_hash, name, role, store_id, created_at, status) 
VALUES ('u1', 'm_default', 'admin', '$2b$10$Nksuuy5yXrYkJn9ZCZckmeDXst2ZNdpTCUFsmdg9oldUczcvsY46u', '系统管理员', 'merchant_admin', NULL, 1675718400000, 'active');

INSERT IGNORE INTO users (id, merchant_id, username, password_hash, name, role, store_id, created_at, status) 
VALUES ('u2', 'm_default', 'manager1', '$2b$10$qjV60/Khg9hrOMYcNHvzTOI4LenOYntMF5AZ7qv9ImfqYFVnD.a9.', '一店店长', 'store_manager', 's1', 1675718400000, 'active');

INSERT IGNORE INTO users (id, merchant_id, username, password_hash, name, role, store_id, created_at, status) 
VALUES ('u3', 'm_default', 'cashier1', '$2b$10$qjV60/Khg9hrOMYcNHvzTOI4LenOYntMF5AZ7qv9ImfqYFVnD.a9.', '一店收银员', 'cashier', 's1', 1675718400000, 'active');

INSERT IGNORE INTO users (id, merchant_id, username, password_hash, name, role, store_id, created_at, status) 
VALUES ('u4', 'm_default', 'cashier2', '$2b$10$qjV60/Khg9hrOMYcNHvzTOI4LenOYntMF5AZ7qv9ImfqYFVnD.a9.', '二店收银员', 'cashier', 's2', 1675718400000, 'active');
