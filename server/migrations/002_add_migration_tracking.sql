-- 创建迁移追踪表
-- 此文件用于保持迁移系统规范性，即使 migrate.js 内部已包含此逻辑
CREATE TABLE IF NOT EXISTS _migrations (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL UNIQUE,
    executed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
