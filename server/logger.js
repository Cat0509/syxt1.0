const fs = require('fs');
const path = require('path');

function ensureDir(dir) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

function resolveLogDir() {
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

    return __dirname;
}

function getLogFile() {
    const logDir = resolveLogDir();
    ensureDir(logDir);
    return path.join(logDir, 'app.log');
}

function appendLog(message) {
    fs.appendFileSync(getLogFile(), message);
}

function formatMessage(level, message) {
    const timestamp = new Date().toISOString();
    return `[${timestamp}] ${level.toUpperCase()}: ${message}\n`;
}

const logger = {
    debug: (msg) => {
        // Only log debug messages when DEBUG env is set
        if (process.env.DEBUG) {
            const fullMsg = formatMessage('debug', msg);
            console.log(fullMsg.trim());
            appendLog(fullMsg);
        }
    },
    info: (msg) => {
        const fullMsg = formatMessage('info', msg);
        console.log(fullMsg.trim());
        appendLog(fullMsg);
    },
    error: (msg, err) => {
        let errDetails = '';
        if (err) {
            errDetails = `\nStack: ${err.stack || err}`;
        }
        const fullMsg = formatMessage('error', `${msg}${errDetails}`);
        console.error(fullMsg.trim());
        appendLog(fullMsg);
    },
    warn: (msg) => {
        const fullMsg = formatMessage('warn', msg);
        console.warn(fullMsg.trim());
        appendLog(fullMsg);
    }
};

module.exports = logger;
