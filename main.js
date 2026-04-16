const { app, BrowserWindow, Menu, ipcMain } = require('electron');
const path = require('path');
const { spawn } = require('child_process');

let serverProcess = null;

function startBackend() {
    if (serverProcess) return;

    const serverDir = path.join(__dirname, 'server');
    const isDev = process.env.NODE_ENV === 'development';

    // 在开发环境下启动 nodemon，在生产环境下直接启动 node
    const command = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const args = isDev ? ['run', 'dev'] : ['start'];

    serverProcess = spawn(command, args, {
        cwd: serverDir,
        shell: true
    });

    serverProcess.stdout.on('data', (data) => {
        console.log(`Server: ${data}`);
    });

    serverProcess.stderr.on('data', (data) => {
        console.error(`Server Error: ${data}`);
    });

    serverProcess.on('close', (code) => {
        console.log(`Server process exited with code ${code}`);
        serverProcess = null;
    });
}

function createWindow() {
    // 创建浏览器窗口
    const mainWindow = new BrowserWindow({
        width: 1280,
        height: 800,
        minWidth: 1024,
        minHeight: 768,
        webPreferences: {
            nodeIntegration: false, // 安全起见，禁用Node集成
            contextIsolation: true, // 启用上下文隔离
            preload: path.join(__dirname, 'preload.js') // 如果需要预加载脚本
        },
        // icon: path.join(__dirname, 'icon.png') // 如果有图标的话
    });

    // 加载 index.html
    mainWindow.loadFile('index.html');

    // 默认不打开开发者工具，但可以通过菜单打开
    // mainWindow.webContents.openDevTools();

    // 可以在这里根据环境变量自动开启
    if (process.env.NODE_ENV === 'development') {
        mainWindow.webContents.openDevTools();
    }
}

// 监听启动后端请求
ipcMain.on('start-backend', () => {
    console.log('Starting backend via IPC...');
    startBackend();
});

// 当 Electron 完成初始化并准备创建浏览器窗口时调用此方法
app.whenReady().then(() => {
    // 默认情况下，我们可以选则在这里启动，或者等前端指令
    // startBackend(); 
    createWindow();

    app.on('activate', function () {
        // macOS 中，点击 dock 图标且没有其他窗口打开时，通常会重新创建一个窗口
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

// 除了 macOS 外，当所有窗口都被关闭的时候退出程序。
app.on('window-all-closed', function () {
    if (serverProcess) {
        // 尝试关闭服务器
        if (process.platform === 'win32') {
            spawn("taskkill", ["/pid", serverProcess.pid, '/f', '/t']);
        } else {
            serverProcess.kill();
        }
    }
    if (process.platform !== 'darwin') app.quit();
});
