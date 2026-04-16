const express = require('express');
const router = express.Router();
const db = require('../db');
const { ApiResponse } = require('../utils');
const logger = require('../logger');

// 简单健康检查与基础同步元数据
router.get('/heartbeat', async (req, res) => {
    try {
        const merchantCount = await db.getMerchantCount();
        ApiResponse.success(res, {
            status: 'online',
            serverTime: new Date().toISOString(),
            initialized: merchantCount > 0,
            version: '4.0.0-foundation'
        });
    } catch (err) {
        logger.error('Sync Heartbeat failed', err);
        ApiResponse.error(res, 'Sync service unavailable', 500);
    }
});

// 获取设备同步状态基础信息
router.get('/status/:deviceId', async (req, res) => {
    const { deviceId } = req.params;
    try {
        const device = await db.getDeviceById(deviceId);
        if (!device) {
            return ApiResponse.error(res, 'Device not recognized', 404);
        }
        ApiResponse.success(res, {
            device_id: device.id,
            last_sync_at: device.last_login_at,
            name: device.name,
            is_active: device.status === 'active'
        });
    } catch (err) {
        logger.error(`Failed to get status for device ${deviceId}`, err);
        ApiResponse.error(res, 'Database error');
    }
});

module.exports = router;
