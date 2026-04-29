# 如意收银系统 1.0

如意收银系统 6.0 是基于 Electron + Node.js + SQLite 的门店端 POS 收银系统。当前版本已从早期 MySQL 后端改造为本地 SQLite 存储，并将后端服务改为由 Electron 主进程直接启动，客户电脑不需要安装 Node.js、npm、MySQL、Python 或 Visual Studio Build Tools。

## 当前状态

已完成：

- 使用 SQLite 作为门店端本地数据库。
- 首次启动通过 `/api/v1/auth/init-status` 判断是否进入初始化向导。
- Electron 主进程直接启动后端服务，不再依赖 `npm.cmd start`。
- 后端数据库写入 Electron `userData` 目录，避免写入安装目录。
- 自动验收脚本使用临时数据库，不会修改真实 `server/data.db`。
- `better-sqlite3` 已提升到根目录依赖，打包时不再携带 `server/node_modules`。

已验证：

```text
npm run verify:sqlite 通过
node --check 检查 58 个 JS 文件，失败 0 个
server/npm test 通过：40 passed, 0 failed
```

仍需在打包机完成：

- 安装 Visual Studio C++ Build Tools。
- 执行 Electron 原生依赖重建。
- 执行 `npm run dist` 并在干净 Windows 客户机上验收安装包。

## 环境要求

开发机建议：

- Windows x64
- Node.js x64，建议使用 Node LTS
- npm

打包机额外需要：

- Visual Studio Build Tools
- `Desktop development with C++`
- MSVC v143
- Windows 10/11 SDK

客户电脑不需要安装：

- Node.js
- npm
- MySQL
- Python
- Visual Studio Build Tools

## 安装依赖

在项目根目录执行：

```powershell
cd D:\1rjkf\syxtcksl\syxt6.0
npm install
```

说明：

- 运行时依赖放在项目根目录，由 Electron 应用统一使用。
- `server/node_modules` 不再需要，打包时也会被排除。
- 后端仍保留 `server/package.json`，用于脚本兼容和说明，但实际运行优先使用根目录依赖。

## 本地开发启动

启动桌面端：

```powershell
npm start
```

Electron 启动后会在主进程中加载：

```text
server/index.js
```

并启动本地 API 服务：

```text
http://localhost:3000
```

## 后端单独启动

如需只启动后端：

```powershell
cd D:\1rjkf\syxtcksl\syxt6.0\server
npm start
```

或直接：

```powershell
node index.js
```

## 验证 SQLite 原生模块

在根目录执行：

```powershell
npm run verify:sqlite
```

成功时应输出：

```text
{ ok: 1 }
```

## 自动验收

在 `server` 目录执行：

```powershell
cd D:\1rjkf\syxtcksl\syxt6.0\server
npm test
```

验收覆盖：

- `/health`
- 初始化状态
- 初始化设置
- 登录
- 商品同步
- 创建订单
- 现金支付
- 订单状态
- 取消订单与库存恢复
- 同步队列
- 备份接口
- 日结报表

当前通过结果：

```text
Passed: 40
Failed: 0
ALL SQLITE ACCEPTANCE TESTS PASSED
```

## 数据库位置

开发环境默认可使用：

```text
server/data.db
```

Electron 运行时默认写入用户数据目录：

```text
%APPDATA%\如意收银系统\RuyiPOS\data.db
```

实际路径由 `main.js` 设置：

```text
process.env.DB_PATH
process.env.BACKUP_DIR
```

也可以通过环境变量覆盖：

```powershell
$env:DB_PATH="D:\path\to\data.db"
$env:BACKUP_DIR="D:\path\to\backups"
```

## 打包前原生依赖重建

`better-sqlite3` 是原生模块。普通 Node 验收通过，不代表 Electron 安装包一定可用；打包前必须按 Electron ABI 重建。

在已安装 Visual Studio C++ Build Tools 的打包机上执行：

```powershell
cd D:\1rjkf\syxtcksl\syxt6.0
npm run rebuild:native
```

如果提示找不到 Python，可临时指定 Python：

```powershell
$env:npm_config_python="C:\Path\To\python.exe"
npm run rebuild:native
```

如果提示找不到 Visual Studio，需要安装：

```text
Visual Studio Build Tools
Desktop development with C++
MSVC v143
Windows 10/11 SDK
```

## 打包

打包目录版：

```powershell
npm run pack
```

生成安装包：

```powershell
npm run dist
```

打包配置要点：

- `server/node_modules` 被排除。
- `better-sqlite3` 位于根目录依赖。
- `node_modules/better-sqlite3/**/*` 通过 `asarUnpack` 解包。
- SQLite 数据库写入用户数据目录。

## 客户机验收

在干净 Windows x64 客户机上验证：

1. 不安装 Node.js。
2. 不安装 npm。
3. 不安装 MySQL。
4. 不安装 Python。
5. 不安装 Visual Studio Build Tools。
6. 安装或运行打包产物。
7. 首次启动进入初始化向导。
8. 初始化后进入主界面。
9. 下单、支付、取消订单、库存恢复正常。
10. 重启后数据仍然存在。

## 项目结构

```text
.
├─ main.js                  Electron 主进程，负责启动后端与窗口
├─ preload.js               主界面预加载脚本
├─ preload-wizard.js        初始化向导预加载脚本
├─ index.html               收银主界面
├─ setup-wizard.html        初始化向导
├─ app.js                   前端业务控制器
├─ styles.css               样式
├─ server/
│  ├─ index.js              后端入口，可独立启动，也可由 Electron require
│  ├─ db.js                 SQLite 数据访问层
│  ├─ sqlite_schema.sql     SQLite schema
│  ├─ routes/               API 路由
│  ├─ scripts/              验收与开发脚本
│  ├─ backup_service.js     备份服务
│  ├─ sync_service.js       同步队列服务
│  └─ order_timeout.js      订单超时取消服务
└─ plan/                    开发计划与验收记录
```

## Git 与运行产物

以下文件不应提交：

```text
server/data.db
server/data.db-shm
server/data.db-wal
server/backups/
server/d_/
server/*.log
node_modules/
dist/
```

旧 MySQL 文件如需保留，只作为历史参考放入：

```text
server/legacy/
```

4.0/5.0 之前的 MySQL 脚本不参与 6.0 门店端运行、验收和打包。

