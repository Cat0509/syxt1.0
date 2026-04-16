# 如意收银系统 (POS) - SaaS 全能版

专业的云端收银系统（SaaS 架构），采用 Electron 桌面框架结合 Node.js + MySQL 后端服务，支持多商户隔离、多门店管理、角色权限控制 (RBAC) 及安全的数据同步。

## ✨ 主要特性

### 核心功能
- **SaaS 架构**：支持多商户 (Merchant) 独立运营，数据物理隔离。
- **多门店管理**：单商户下可开设多家分店，支持跨店数据统计。
- **角色权限 (RBAC)**：
  - `merchant_admin` (总部管理员)：全面管理商户下所有门店、员工及全局报表。
  - `store_manager` (门店店长)：管理所属门店的员工、库存及业务。
  - `cashier` (收银员)：基础收银及个人业绩统计。
- **公开放开店**：支持新商户通过注册界面自主开店，自动初始化商户及默认店面。

### 安全与稳定性
- **安全加固**：全站密码采用 `bcrypt` 哈希存储，登录采用 JWT 令牌。
- **账号状态控制**：支持账号启用/停用，实时拦截非活动用户访问。
- **后端守护**：内置后台运行脚本，确保收银台与后端服务始终同步。
- **数据持久化**：采用企业级 MySQL 数据库，保证高并发及海量数据存储的可靠性。

## 🚀 运行指南

### 1. 数据库配置
1. 安装 MySQL 并创建数据库（如 `ruyi_pos`）。
2. 在 `server/.env` 中配置数据库连接信息。
3. 执行 `server/mysql_schema.sql` 初始化表结构及预置数据。
4. (可选) 运行 `node server/migrate_to_mysql.js` 将旧版 JSON 数据迁移至数据库。

### 2. 启动服务
#### 后端同步服务
在 `server` 目录下执行：
```bash
npm install
npm run dev
```
或使用守护进程模式：
```bash
npm run dev:daemon  # 启动后台守护
npm run dev:stop    # 停止后台守护
```

#### 收银台 (桌面端)
在根目录下执行：
```bash
npm install
npm start
```

# 如意收银系统 (POS) - SaaS 全能版

专业的云端收银系统（SaaS 架构），采用 Electron 桌面框架结合 Node.js + MySQL 后端服务，支持多商户隔离、多门店管理、角色权限控制 (RBAC) 及安全的数据同步。

## ✨ 主要特性

### 核心功能
- **SaaS 架构**：支持多商户 (Merchant) 独立运营，数据物理隔离。
- **多门店管理**：单商户下可开设多家分店，支持跨店数据统计。
- **角色权限 (RBAC)**：
  - `merchant_admin` (总部管理员)：全面管理商户下所有门店、员工及全局报表。
  - `store_manager` (门店店长)：管理所属门店的员工、库存及业务。
  - `cashier` (收银员)：基础收银及个人业绩统计。
- **公开放开店**：支持新商户通过注册界面自主开店，自动初始化商户及默认店面。

### 安全与稳定性
- **安全加固**：全站密码采用 `bcrypt` 哈希存储，登录采用 JWT 令牌。
- **账号状态控制**：支持账号启用/停用，实时拦截非活动用户访问。
- **后端守护**：内置后台运行脚本，确保收银台与后端服务始终同步。
- **数据持久化**：采用企业级 MySQL 数据库，保证高并发及海量数据存储的可靠性。

## 🚀 运行指南

### 1. 数据库配置
1. 安装 MySQL 并创建数据库（如 `ruyi_pos`）。
2. 在 `server/.env` 中配置数据库连接信息。
3. 执行 `server/mysql_schema.sql` 初始化表结构及预置数据。
4. (可选) 运行 `node server/migrate_to_mysql.js` 将旧版 JSON 数据迁移至数据库。

### 2. 启动服务
#### 后端同步服务
在 `server` 目录下执行：
```bash
npm install
npm run dev
```
或使用守护进程模式：
```bash
npm run dev:daemon  # 启动后台守护
npm run dev:stop    # 停止后台守护
```

#### 收银台 (桌面端)
在根目录下执行：
```bash
npm install
npm start
```

## 📁 项目结构

- `main.js` & `preload.js` - Electron 桌面端核心配置
- `app.js` - 前端 Controller 与业务逻辑
- `index.html` & `styles.css` - 响应式 POS 界面
- `server/` - 云端 SaaS 后端服务
- `db.js` - MySQL 数据交互组件

## 📊 登录凭据 (默认种子数据)
| 角色 | 商户号 | 用户名 | 原始密码 |
| :--- | :--- | :--- | :--- |
| 总部管理员 | m_default | admin | admin |
| 门店店长 | m_default | manager1 | 123456 |
| 收银员 | m_default | cashier1 | 123456 |

> [!IMPORTANT]
> 种子数据已全部哈希化处理。登录时必须输入正确的商户号 (Merchant ID)、用户名及密码。

---
**开发者**: cat  
**版本**: v4.0 (第一阶段定稿版)  
**更新日期**: 2026-03-11
