const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const serverDir = path.resolve(__dirname, '..');
const pidFile = path.join(serverDir, '.tmp_server_pid');

if (!fs.existsSync(pidFile)) {
  console.log('No pid file found. Server may not be running.');
  process.exit(0);
}

const raw = fs.readFileSync(pidFile, 'utf8').trim();
const pid = Number(raw);

if (!Number.isFinite(pid)) {
  fs.unlinkSync(pidFile);
  console.log('Invalid pid file. Removed.');
  process.exit(0);
}

try {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/f', '/t'], { stdio: 'ignore' });
  } else {
    process.kill(pid);
  }
  console.log(`Stopped dev server (pid ${pid}).`);
} catch (err) {
  console.log(`Failed to stop pid ${pid}: ${err.message}`);
} finally {
  try { fs.unlinkSync(pidFile); } catch {}
}
