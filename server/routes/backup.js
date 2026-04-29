const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const backupService = require('../backup_service');
const { ApiResponse, asyncHandler } = require('../utils');
const { authenticate } = require('../middleware/auth');
const { requireRole, requireActiveUser } = require('../middleware/rbac');
const logger = require('../logger');

// List all backups
router.get('/', authenticate, requireActiveUser, requireRole(['merchant_admin']), asyncHandler(async (req, res) => {
    const backups = backupService.listBackups();
    ApiResponse.success(res, backups);
}));

// Create a manual backup
router.post('/create', authenticate, requireActiveUser, requireRole(['merchant_admin', 'store_manager']), asyncHandler(async (req, res) => {
    const result = backupService.createBackup();
    if (result.success) {
        ApiResponse.success(res, result, '备份创建成功');
    } else {
        ApiResponse.error(res, '备份失败: ' + result.error, 500);
    }
}));

// Restore from a backup
router.post('/restore', authenticate, requireActiveUser, requireRole(['merchant_admin']), asyncHandler(async (req, res) => {
    const { filename } = req.body;
    if (!filename) {
        return ApiResponse.error(res, '请指定备份文件名', 400, 400);
    }

    // Validate filename to prevent path traversal
    if (!filename.startsWith('ruyi_backup_') || filename.includes('..') || filename.includes('/')) {
        return ApiResponse.error(res, '无效的备份文件名', 400, 400);
    }

    const result = backupService.restoreFromBackup(filename);
    if (result.success) {
        ApiResponse.success(res, result, '数据库已恢复，请重启应用');
    } else {
        ApiResponse.error(res, '恢复失败: ' + result.error, 500);
    }
}));

// Download a backup file
router.get('/download/:filename', authenticate, requireActiveUser, requireRole(['merchant_admin']), asyncHandler(async (req, res) => {
    const { filename } = req.params;

    // Validate filename
    if (!filename.startsWith('ruyi_backup_') || filename.includes('..') || filename.includes('/')) {
        return ApiResponse.error(res, '无效的备份文件名', 400, 400);
    }

    const backups = backupService.listBackups();
    const backup = backups.find(b => b.filename === filename);
    if (!backup) {
        return ApiResponse.error(res, '备份文件不存在', 404, 404);
    }

    const BACKUP_DIR = process.env.BACKUP_DIR || path.join(__dirname, 'backups');
    const filePath = path.join(BACKUP_DIR, filename);

    if (!fs.existsSync(filePath)) {
        return ApiResponse.error(res, '备份文件不存在', 404, 404);
    }

    res.download(filePath, filename);
}));

// Delete a backup
router.delete('/:filename', authenticate, requireActiveUser, requireRole(['merchant_admin']), asyncHandler(async (req, res) => {
    const { filename } = req.params;

    if (!filename.startsWith('ruyi_backup_') || filename.includes('..') || filename.includes('/')) {
        return ApiResponse.error(res, '无效的备份文件名', 400, 400);
    }

    const BACKUP_DIR = process.env.BACKUP_DIR || path.join(__dirname, 'backups');
    const filePath = path.join(BACKUP_DIR, filename);

    if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        ApiResponse.success(res, { filename }, '备份已删除');
    } else {
        ApiResponse.error(res, '备份文件不存在', 404, 404);
    }
}));

module.exports = router;
