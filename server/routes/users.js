const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const db = require('../db');
const { ApiResponse, asyncHandler } = require('../utils');
const { authenticate } = require('../middleware/auth');
const { requireRole, requireActiveUser, requireStoreScope } = require('../middleware/rbac');

// 获取员工列表
router.get('/', authenticate, requireActiveUser, requireRole(['merchant_admin', 'store_manager']), requireStoreScope, asyncHandler(async (req, res) => {
    const users = await db.getUsers(req.user.merchant_id, req.effectiveStoreId);
    // 隐藏敏感信息
    const safeUsers = users.map(({ password: _, password_hash: __, ...u }) => u);
    ApiResponse.success(res, safeUsers);
}));

// 创建员工
router.post('/', authenticate, requireActiveUser, requireRole(['merchant_admin', 'store_manager']), asyncHandler(async (req, res) => {
    const { username, name, password, role, store_id } = req.body;

    if (!username || !name || !password || !role) {
        return ApiResponse.error(res, '请提供完整的员工信息', 400, 400);
    }

    // 角色创建权限校验
    if (req.user.role === 'store_manager') {
        // 店长只能创建本门店的收银员
        if (role !== 'cashier') {
            return ApiResponse.error(res, '店长仅能创建收银员角色', 403, 403);
        }
        if (store_id && store_id !== req.user.store_id) {
            return ApiResponse.error(res, '店长仅能为本门店创建员工', 403, 403);
        }
    }

    // 检查用户名是否已存在
    const existing = await db.getUserByUsername(username, req.user.merchant_id);
    if (existing) {
        return ApiResponse.error(res, '用户名已存在', 400, 400);
    }

    const password_hash = await bcrypt.hash(password, 10);
    const newUser = await db.saveUser({
        username,
        name,
        password_hash,
        role,
        store_id: req.user.role === 'merchant_admin' ? store_id : req.user.store_id,
        status: 'active'
    }, req.user.merchant_id);

    const { password: _, password_hash: __, ...info } = newUser;
    ApiResponse.success(res, info, '员工创建成功');
}));

// 修改员工状态 (启用/停用)
router.patch('/:id/status', authenticate, requireActiveUser, requireRole(['merchant_admin', 'store_manager']), asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;

    if (!['active', 'disabled'].includes(status)) {
        return ApiResponse.error(res, '非法的状态值', 400, 400);
    }

    const targetUser = await db.getUserById(id, req.user.merchant_id);
    if (!targetUser) {
        return ApiResponse.error(res, '员工不存在', 404, 404);
    }

    // 权限校验
    if (req.user.role === 'store_manager') {
        if (targetUser.store_id !== req.user.store_id || targetUser.role !== 'cashier') {
            return ApiResponse.error(res, '店长仅能管理本门店的收银员', 403, 403);
        }
    }

    await db.updateUserStatus(id, req.user.merchant_id, status);
    ApiResponse.success(res, null, `员工已${status === 'active' ? '启用' : '停用'}`);
}));

// 重置员工密码
router.patch('/:id/password-reset', authenticate, requireActiveUser, requireRole(['merchant_admin', 'store_manager']), asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { newPassword } = req.body;

    if (!newPassword) {
        return ApiResponse.error(res, '请提供新密码', 400, 400);
    }

    const targetUser = await db.getUserById(id, req.user.merchant_id);
    if (!targetUser) {
        return ApiResponse.error(res, '员工不存在', 404, 404);
    }

    // 权限校验
    if (req.user.role === 'store_manager') {
        if (targetUser.store_id !== req.user.store_id || targetUser.role !== 'cashier') {
            return ApiResponse.error(res, '店长仅能重置本门店收银员的密码', 403, 403);
        }
    }

    const password_hash = await bcrypt.hash(newPassword, 10);
    await db.updateUserPassword(id, req.user.merchant_id, password_hash);
    ApiResponse.success(res, null, '密码重置成功');
}));

module.exports = router;
