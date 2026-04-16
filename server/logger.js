const fs = require('fs');
const path = require('path');

const logFile = path.join(__dirname, 'app.log');

function formatMessage(level, message) {
    const timestamp = new Date().toISOString();
    return `[${timestamp}] ${level.toUpperCase()}: ${message}\n`;
}

const logger = {
    info: (msg) => {
        const fullMsg = formatMessage('info', msg);
        console.log(fullMsg.trim());
        fs.appendFileSync(logFile, fullMsg);
    },
    error: (msg, err) => {
        let errDetails = '';
        if (err) {
            errDetails = `\nStack: ${err.stack || err}`;
        }
        const fullMsg = formatMessage('error', `${msg}${errDetails}`);
        console.error(fullMsg.trim());
        fs.appendFileSync(logFile, fullMsg);
    },
    warn: (msg) => {
        const fullMsg = formatMessage('warn', msg);
        console.warn(fullMsg.trim());
        fs.appendFileSync(logFile, fullMsg);
    }
};

module.exports = logger;
