/**
 * Ruyi POS - Backup Service
 *
 * 数据自动备份服务：
 * - 每日自动备份 SQLite 数据库
 * - 支持手动触发备份
 * - 支持从备份恢复
 * - 自动清理超过 30 天的备份文件
 *
 * 配置（环境变量）：
 *   BACKUP_DIR       - 备份目录（默认：./backups）
 *   BACKUP_INTERVAL  - 自动备份间隔（默认：86400000ms = 24小时）
 *   BACKUP_RETENTION - 备份保留天数（默认：30天）
 */

const fs = require('fs');
const path = require('path');
const db = require('./db');
const logger = require('./logger');

const BACKUP_DIR = process.env.BACKUP_DIR || path.join(__dirname, 'backups');
const BACKUP_INTERVAL_MS = Number.parseInt(process.env.BACKUP_INTERVAL || '86400000', 10);
const BACKUP_RETENTION_DAYS = Number.parseInt(process.env.BACKUP_RETENTION || '30', 10);

let backupTimer = null;

/**
 * Ensure backup directory exists.
 */
function ensureBackupDir() {
    if (!fs.existsSync(BACKUP_DIR)) {
        fs.mkdirSync(BACKUP_DIR, { recursive: true });
    }
}

/**
 * Create a backup of the SQLite database.
 * Uses SQLite's built-in backup API for a consistent snapshot.
 * @returns {Object} { success, filename, path, size }
 */
function createBackup() {
    try {
        const sqliteDb = db.getDb();
        if (!sqliteDb) {
            return { success: false, error: 'Database not initialized' };
        }

        ensureBackupDir();

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const filename = `ruyi_backup_${timestamp}.db`;
        const backupPath = path.join(BACKUP_DIR, filename);

        // Use better-sqlite3's backup API for a consistent snapshot
        // backup() accepts either a file path (string) or a Database object
        const Database = require('better-sqlite3');
        const backupDb = new Database(backupPath);
        sqliteDb.backup(backupDb);
        backupDb.close();

        const stats = fs.statSync(backupPath);

        logger.info(`[Backup] Created backup: ${filename} (${(stats.size / 1024).toFixed(1)} KB)`);

        // Clean up old backups
        cleanOldBackups();

        return {
            success: true,
            filename,
            path: backupPath,
            size: stats.size,
            size_human: `${(stats.size / 1024).toFixed(1)} KB`
        };
    } catch (err) {
        logger.error('[Backup] Failed to create backup', err);
        return { success: false, error: err.message };
    }
}

/**
 * Restore database from a backup file.
 * WARNING: This will overwrite the current database!
 * @param {string} backupFilename - The backup filename to restore from
 * @returns {Object} { success, message }
 */
function restoreFromBackup(backupFilename) {
    try {
        const backupPath = path.join(BACKUP_DIR, backupFilename);

        if (!fs.existsSync(backupPath)) {
            return { success: false, error: `备份文件不存在: ${backupFilename}` };
        }

        const dbPath = db.getDbPath ? db.getDbPath() : path.join(__dirname, 'data.db');

        // Create a timestamped backup of current DB before restoring
        const preRestoreTimestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const preRestorePath = path.join(BACKUP_DIR, `pre_restore_${preRestoreTimestamp}.db`);
        if (fs.existsSync(dbPath)) {
            fs.copyFileSync(dbPath, preRestorePath);
        }

        // Copy backup file to database location
        fs.copyFileSync(backupPath, dbPath);

        logger.info(`[Backup] Restored from: ${backupFilename}`);

        return {
            success: true,
            message: `已从 ${backupFilename} 恢复数据库。原数据库已备份为 pre_restore_${preRestoreTimestamp}.db`,
            preRestoreBackup: `pre_restore_${preRestoreTimestamp}.db`
        };
    } catch (err) {
        logger.error('[Backup] Failed to restore', err);
        return { success: false, error: err.message };
    }
}

/**
 * List all available backups.
 * @returns {Array} List of backup info objects
 */
function listBackups() {
    ensureBackupDir();

    try {
        const files = fs.readdirSync(BACKUP_DIR)
            .filter(f => f.startsWith('ruyi_backup_') && f.endsWith('.db'))
            .map(f => {
                const filePath = path.join(BACKUP_DIR, f);
                const stats = fs.statSync(filePath);
                return {
                    filename: f,
                    size: stats.size,
                    size_human: `${(stats.size / 1024).toFixed(1)} KB`,
                    created_at: stats.mtime.toISOString()
                };
            })
            .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

        return files;
    } catch (err) {
        logger.error('[Backup] Failed to list backups', err);
        return [];
    }
}

/**
 * Delete old backups exceeding retention period.
 */
function cleanOldBackups() {
    ensureBackupDir();

    try {
        const cutoffTime = Date.now() - (BACKUP_RETENTION_DAYS * 24 * 60 * 60 * 1000);
        const files = fs.readdirSync(BACKUP_DIR)
            .filter(f => f.startsWith('ruyi_backup_') && f.endsWith('.db'));

        let deleted = 0;
        for (const f of files) {
            const filePath = path.join(BACKUP_DIR, f);
            const stats = fs.statSync(filePath);
            if (stats.mtimeMs < cutoffTime) {
                fs.unlinkSync(filePath);
                deleted++;
            }
        }

        if (deleted > 0) {
            logger.info(`[Backup] Cleaned up ${deleted} old backup(s) (older than ${BACKUP_RETENTION_DAYS} days)`);
        }
    } catch (err) {
        logger.error('[Backup] Failed to clean old backups', err);
    }
}

/**
 * Start automatic backup timer.
 */
function startAutoBackup() {
    if (backupTimer) {
        clearInterval(backupTimer);
    }

    logger.info(`[Backup] Auto-backup started (interval: ${BACKUP_INTERVAL_MS / 3600000}h, retention: ${BACKUP_RETENTION_DAYS}d)`);

    // Do an initial backup after 30 seconds
    setTimeout(() => {
        createBackup();
    }, 30000);

    backupTimer = setInterval(() => {
        createBackup();
    }, BACKUP_INTERVAL_MS);
}

/**
 * Stop automatic backup timer.
 */
function stopAutoBackup() {
    if (backupTimer) {
        clearInterval(backupTimer);
        backupTimer = null;
        logger.info('[Backup] Auto-backup stopped');
    }
}

module.exports = {
    createBackup,
    restoreFromBackup,
    listBackups,
    cleanOldBackups,
    startAutoBackup,
    stopAutoBackup
};
