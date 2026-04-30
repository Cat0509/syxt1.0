const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

let cachedJwtSecret = null;

function ensureDir(dir) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

function resolveRuntimeDir() {
    if (process.env.RUYI_RUNTIME_DIR) {
        return process.env.RUYI_RUNTIME_DIR;
    }

    if (process.env.DB_PATH) {
        return path.dirname(process.env.DB_PATH);
    }

    try {
        const { app } = require('electron');
        if (app && app.getPath) {
            return path.join(app.getPath('userData'), 'RuyiPOS');
        }
    } catch (_) {
        // Running outside Electron.
    }

    return path.join(__dirname, '.runtime');
}

function readSecret(filePath) {
    if (!fs.existsSync(filePath)) {
        return '';
    }
    return fs.readFileSync(filePath, 'utf8').trim();
}

function writeSecret(filePath, secret) {
    fs.writeFileSync(filePath, `${secret}\n`, { mode: 0o600 });
}

function getJwtSecret() {
    if (cachedJwtSecret) {
        return cachedJwtSecret;
    }

    const envSecret = (process.env.JWT_SECRET || '').trim();
    if (envSecret) {
        cachedJwtSecret = envSecret;
        return cachedJwtSecret;
    }

    const runtimeDir = resolveRuntimeDir();
    ensureDir(runtimeDir);

    const secretFile = process.env.JWT_SECRET_FILE || path.join(runtimeDir, 'jwt_secret');
    const existingSecret = readSecret(secretFile);
    if (existingSecret) {
        cachedJwtSecret = existingSecret;
        return cachedJwtSecret;
    }

    cachedJwtSecret = crypto.randomBytes(48).toString('hex');
    writeSecret(secretFile, cachedJwtSecret);
    return cachedJwtSecret;
}

module.exports = {
    getJwtSecret
};
