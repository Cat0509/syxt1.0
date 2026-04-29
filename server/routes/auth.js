const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const db = require('../db');
const { ApiResponse, asyncHandler } = require('../utils');
const { generateToken, authenticate } = require('../middleware/auth');
const { requireActiveUser } = require('../middleware/rbac');
const logger = require('../logger');

// Login security config
const MAX_LOGIN_ATTEMPTS = 5;
const LOCK_DURATION_MS = 15 * 60 * 1000; // 15 minutes

// 登录接口
router.post('/login', asyncHandler(async (req, res) => {
    const { username, password, merchantId } = req.body;
    if (!username || !password || !merchantId) {
        return ApiResponse.error(res, '请输入商户号、用户名和密码', 400, 400);
    }

    const actualMerchantId = merchantId;
    const now = Date.now();

    const user = await db.getUserByUsername(username, actualMerchantId);

    // Ensure user exists and is active
    if (!user || user.status !== 'active') {
        return ApiResponse.error(res, '用户名或密码错误，或账号已停用', 401, 401);
    }

    // Check if account is locked
    const failCount = Number(user.fail_count || 0);
    const lockUntil = Number(user.lock_until || 0);

    if (failCount >= MAX_LOGIN_ATTEMPTS && lockUntil > now) {
        const remainingMin = Math.ceil((lockUntil - now) / 60000);
        return ApiResponse.error(res, `账号已锁定，请 ${remainingMin} 分钟后再试`, 423, 423);
    }

    // If lock period has expired, reset fail count
    if (failCount >= MAX_LOGIN_ATTEMPTS && lockUntil <= now) {
        const sqliteDb = db.getDb();
        sqliteDb.prepare('UPDATE users SET fail_count = 0, lock_until = 0 WHERE id = ?').run(user.id);
    }

    // Verify Password
    let isMatch = false;
    if (user.password_hash) {
        isMatch = await bcrypt.compare(password, user.password_hash);
    } else if (user.password && user.password === password) {
        // Fallback for legacy passwords
        isMatch = true;
    }

    if (!isMatch) {
        // Increment fail count
        const newFailCount = failCount + 1;
        const newLockUntil = newFailCount >= MAX_LOGIN_ATTEMPTS ? (now + LOCK_DURATION_MS) : 0;

        const sqliteDb = db.getDb();
        sqliteDb.prepare(
            'UPDATE users SET fail_count = ?, lock_until = ? WHERE id = ?'
        ).run(newFailCount, newLockUntil, user.id);

        // Log failed login attempt
        await db.saveAuditLog({
            action: 'LOGIN_FAILED',
            details: { username, reason: '密码错误', fail_count: newFailCount, locked: newFailCount >= MAX_LOGIN_ATTEMPTS },
            store_id: user.store_id,
            user_id: user.id,
            username
        }, actualMerchantId);

        const remaining = MAX_LOGIN_ATTEMPTS - newFailCount;
        if (remaining > 0) {
            return ApiResponse.error(res, `用户名或密码错误，还有 ${remaining} 次尝试机会`, 401, 401);
        } else {
            return ApiResponse.error(res, `密码错误次数过多，账号已锁定 ${LOCK_DURATION_MS / 60000} 分钟`, 423, 423);
        }
    }

    // Login success — reset fail count
    const sqliteDb = db.getDb();
    sqliteDb.prepare('UPDATE users SET fail_count = 0, lock_until = 0 WHERE id = ?').run(user.id);

    // Update last login
    await db.updateLastLogin(user.id, actualMerchantId);

    // Log successful login
    await db.saveAuditLog({
        action: 'LOGIN_SUCCESS',
        details: { username, role: user.role },
        store_id: user.store_id,
        user_id: user.id,
        username
    }, actualMerchantId);

    // Generate JWT token
    const token = generateToken(user);

    // 不返回密码
    const { password: _, password_hash: __, fail_count: ___, lock_until: ____, ...userInfo } = user;

    // 返回带 token 的结果
    ApiResponse.success(res, { ...userInfo, token }, '登录成功');
}));

// 修改本人密码
router.post('/change-password', authenticate, requireActiveUser, asyncHandler(async (req, res) => {
    const { oldPassword, newPassword } = req.body;

    if (!oldPassword || !newPassword) {
        return ApiResponse.error(res, '请提供旧密码和新密码', 400, 400);
    }

    const user = await db.getUserById(req.user.id, req.user.merchant_id);
    if (!user) {
        return ApiResponse.error(res, '用户不存在', 404, 404);
    }

    let isMatch = false;
    if (user.password_hash) {
        isMatch = await bcrypt.compare(oldPassword, user.password_hash);
    } else if (user.password && user.password === oldPassword) {
        isMatch = true;
    }

    if (!isMatch) {
        return ApiResponse.error(res, '旧密码不正确', 400, 400);
    }

    const hashed = await bcrypt.hash(newPassword, 10);
    await db.updateUserPassword(user.id, user.merchant_id, hashed);

    ApiResponse.success(res, null, '密码修改成功');
}));

// 获取当前用户信息
router.get('/me', authenticate, requireActiveUser, asyncHandler(async (req, res) => {
    ApiResponse.success(res, req.user);
}));

// Token 续期接口
router.post('/refresh', authenticate, requireActiveUser, asyncHandler(async (req, res) => {
    // Generate a new token for the authenticated user
    const newToken = generateToken(req.user);
    ApiResponse.success(res, { token: newToken }, 'Token refreshed');
}));

// 检查系统是否全部初始化完成的内部纯函数
async function checkFullyInitialized() {
    const merchantCount = await db.getMerchantCount();
    if (merchantCount === 0) return false;
    
    // Further check for store and admin user
    const [stores] = await db.query('SELECT COUNT(*) as count FROM stores');
    const [admins] = await db.query("SELECT COUNT(*) as count FROM users WHERE role = 'merchant_admin'");
    const [devices] = await db.query('SELECT COUNT(*) as count FROM devices');
    
    return (stores[0].count > 0 && admins[0].count > 0 && devices[0].count > 0);
}

// 获取系统初始化状态
router.get('/init-status', asyncHandler(async (req, res) => {
    const fullyInitialized = await checkFullyInitialized();
    ApiResponse.success(res, { initialized: fullyInitialized });
}));

// 系统初始化接口 (保证原子性)
router.post('/init-setup', asyncHandler(async (req, res) => {
    const fullyInitialized = await checkFullyInitialized();
    
    if (fullyInitialized) {
        return ApiResponse.error(res, '系统已经初始化，不允许再次执行初始化流程', 403, 403);
    }

    const { merchantName, adminName, username, password, storeName, deviceId, deviceName } = req.body;

    if (!merchantName || !adminName || !username || !password || !storeName || !deviceId) {
        return ApiResponse.error(res, '请填写完整的初始化信息', 400, 400);
    }

    try {
        const result = await db.withTransaction(async (conn) => {
            // 0. 清除可能残留的"半初始化"碎片数据，保证空库启动
            await conn.execute('DELETE FROM devices');
            await conn.execute('DELETE FROM users');
            await conn.execute('DELETE FROM stores');
            await conn.execute('DELETE FROM merchants');

            // 1. 创建商户
            const mid = require('../id_utils').generateId();
            await conn.execute(
                'INSERT INTO merchants (id, name, status, created_at) VALUES (?, ?, ?, ?)',
                [mid, merchantName, 'active', Date.now()]
            );

            // 2. 创建第一家门店
            const sid = require('../id_utils').generateId();
            await conn.execute(
                'INSERT INTO stores (id, merchant_id, name, created_at) VALUES (?, ?, ?, ?)',
                [sid, mid, storeName, Date.now()]
            );

            // 3. 创建第一位总部管理员
            const password_hash = await bcrypt.hash(password, 10);
            const uid = require('../id_utils').generateId();
            await conn.execute(
                'INSERT INTO users (id, merchant_id, username, password_hash, name, role, store_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                [uid, mid, username, password_hash, adminName, 'merchant_admin', sid, 'active', Date.now(), Date.now()]
            );

            // 4. 绑定第一台设备
            await conn.execute(
                'INSERT INTO devices (id, name, store_id, status, created_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?)',
                [deviceId, deviceName || '首台收银机', sid, 'active', Date.now(), Date.now()]
            );

            return { merchantId: mid, adminId: uid };
        });

        ApiResponse.success(res, result, '系统初始化成功');
    } catch (err) {
        require('../logger').error('Initialization failed', err);
        ApiResponse.error(res, '系统初始化失败: ' + err.message, 500);
    }
}));

// 公开注册接口 (重构为受限接口)
router.post('/register', asyncHandler(async (req, res) => {
    const merchantCount = await db.getMerchantCount();
    if (merchantCount > 0) {
        return ApiResponse.error(res, '公开注册已关闭，请联系系统管理员或使用初始化流程', 403, 403);
    }
    
    // 如果未初始化且调用了 /register，则引导至 /init-setup 或保持兼容但标记废弃
    // 这里选择直接引导错误或执行类似逻辑
    return ApiResponse.error(res, '请使用 /auth/init-setup 接口进行系统初始化', 400, 400);
}));

module.exports = router;
