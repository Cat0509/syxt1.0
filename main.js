const { app, BrowserWindow, Menu, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

let backendServer = null;
let backendModule = null;
let wizardWindow = null;
let mainWindow = null;

// ---------------------------------------------------------------------------
// Check if the system has been fully initialized via API
// ---------------------------------------------------------------------------
function checkInitStatus() {
    return new Promise((resolve) => {
        const http = require('http');
        const req = http.get('http://localhost:3000/api/v1/auth/init-status', (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    resolve(json.data && json.data.initialized === true);
                } catch (_) {
                    // API error → treat as not initialized
                    resolve(false);
                }
            });
        });
        req.on('error', () => resolve(false));
        req.setTimeout(3000, () => { req.destroy(); resolve(false); });
    });
}

// ---------------------------------------------------------------------------
// Backend server
// ---------------------------------------------------------------------------
function startBackend() {
    if (backendServer) return;

    const dataDir = path.join(app.getPath('userData'), 'RuyiPOS');
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
    }

    process.env.PORT = process.env.PORT || '3000';
    process.env.DB_PATH = process.env.DB_PATH || path.join(dataDir, 'data.db');
    process.env.BACKUP_DIR = process.env.BACKUP_DIR || path.join(dataDir, 'backups');

    backendModule = require('./server/index');
    backendServer = backendModule.startServer({ port: process.env.PORT });
    backendServer.on('close', () => {
        backendServer = null;
    });
}

function stopBackend() {
    if (!backendModule) return;

    backendModule.stopServer(() => {
        backendServer = null;
    });
}

/**
 * Wait for the backend to be ready by polling /health endpoint.
 * Returns true if the server responded successfully.
 */
function waitForBackend(maxRetries = 30, intervalMs = 1000) {
    return new Promise((resolve) => {
        const http = require('http');
        let retries = 0;

        const check = () => {
            retries++;
            const req = http.get('http://localhost:3000/health', (res) => {
                let data = '';
                res.on('data', (chunk) => data += chunk);
                res.on('end', () => {
                    try {
                        const json = JSON.parse(data);
                        if (json.code === 200) {
                            resolve(true);
                            return;
                        }
                    } catch (_) {}
                    retry();
                });
            });
            req.on('error', () => retry());
            req.setTimeout(2000, () => { req.destroy(); retry(); });
        };

        const retry = () => {
            if (retries >= maxRetries) {
                resolve(false);
                return;
            }
            setTimeout(check, intervalMs);
        };

        check();
    });
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------
function createSetupWizard() {
    wizardWindow = new BrowserWindow({
        width: 560,
        height: 680,
        minWidth: 480,
        minHeight: 600,
        resizable: true,
        fullscreenable: false,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload-wizard.js')
        },
        title: '如意收银 - 初始化设置'
    });

    wizardWindow.loadFile('setup-wizard.html');

    // Remove menu bar for cleaner wizard experience
    wizardWindow.setMenuBarVisibility(false);

    wizardWindow.on('closed', () => {
        wizardWindow = null;
    });

    if (process.env.NODE_ENV === 'development') {
        wizardWindow.webContents.openDevTools();
    }
}

function createMainWindow() {
    mainWindow = new BrowserWindow({
        width: 1280,
        height: 800,
        minWidth: 1024,
        minHeight: 768,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js')
        }
    });

    mainWindow.loadFile('index.html');

    if (process.env.NODE_ENV === 'development') {
        mainWindow.webContents.openDevTools();
    }
}

// ---------------------------------------------------------------------------
// IPC handlers
// ---------------------------------------------------------------------------
ipcMain.on('start-backend', () => {
    console.log('Starting backend via IPC...');
    startBackend();
});

// Setup wizard signals completion
ipcMain.on('setup-complete', () => {
    console.log('Setup complete, opening main window...');
    if (wizardWindow) {
        wizardWindow.close();
        wizardWindow = null;
    }
    createMainWindow();
});

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------
app.whenReady().then(async () => {
    // Always start the backend first
    startBackend();

    // Wait for backend to be ready
    const backendReady = await waitForBackend();
    if (!backendReady) {
        console.error('Backend failed to start within timeout.');
        // Still try to open the main window – the user will see an error
        createMainWindow();
        return;
    }

    // Check if system is fully initialized via API (not just file existence)
    const initialized = await checkInitStatus();
    if (!initialized) {
        // First-time launch: show setup wizard
        createSetupWizard();
    } else {
        // Already initialized: go straight to main window
        createMainWindow();
    }

    app.on('activate', function () {
        if (BrowserWindow.getAllWindows().length === 0) {
            // Re-check on activate (macOS)
            checkInitStatus().then(init => {
                if (init) createMainWindow();
                else createSetupWizard();
            });
        }
    });
});

app.on('window-all-closed', function () {
    stopBackend();
    if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
    stopBackend();
});
