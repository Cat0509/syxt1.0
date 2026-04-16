const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const serverDir = path.resolve(__dirname, '..');
const pidFile = path.join(serverDir, '.tmp_server_pid');
const isWin = process.platform === 'win32';
const nodemonCmd = isWin
  ? path.join(serverDir, 'node_modules', '.bin', 'nodemon.cmd')
  : path.join(serverDir, 'node_modules', '.bin', 'nodemon');

function isRunning(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

if (fs.existsSync(pidFile)) {
  const raw = fs.readFileSync(pidFile, 'utf8').trim();
  const pid = Number(raw);
  if (Number.isFinite(pid) && isRunning(pid)) {
    console.log(`Server already running (pid ${pid}).`);
    process.exit(0);
  }
}

if (!fs.existsSync(nodemonCmd)) {
  console.error('nodemon not found. Run npm install in server first.');
  process.exit(1);
}

const child = spawn(nodemonCmd, ['index.js'], {
  cwd: serverDir,
  detached: true,
  stdio: 'ignore',
  windowsHide: true
});

child.unref();
fs.writeFileSync(pidFile, String(child.pid));
console.log(`Dev server started (pid ${child.pid}).`);
