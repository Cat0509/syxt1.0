const fs = require('fs');
const file = 'd:\\1rjkf\\syxt\\app.js';
let text = fs.readFileSync(file, 'utf8');

// 1. _switchViewInternal
let pt1 = `    else if (viewName === 'report') {
      this.transactions = loadTransactions(); // 切换到报表页时刷新缓存
      this.updateMainStats();`;

let rp1 = `    else if (viewName === 'report') {
      // this.transactions 将在 renderReport 中被刷新
      this.updateMainStats();`;

if (text.includes(pt1)) text = text.replace(pt1, rp1);

// 2. renderReport
let pt2 = `    // 从后端拉取今日汇总数据
    this.updateMainStatsFromBackend();

    // 详细统计仍以本地缓存数据为备，逐步迁移
    this.transactions = loadTransactions();
    const { today, week, month } = getReportStats(this.transactions);`;

let rp2 = `    // 从后端拉取今日汇总数据
    this.updateMainStatsFromBackend();

    // 全面接入云端数据，移除本地缓存读取逻辑
    this.transactions = await SyncManager.fetchCloudTransactions(this.currentStoreId) || [];
    const { today, week, month } = getReportStats(this.transactions);`;

if (text.includes(pt2)) text = text.replace(pt2, rp2);

// 3. renderCashierReport
let pt3 = `    // 降级: 本地缓存数据
    this.transactions = loadTransactions();
    const { today } = getReportStats(this.transactions);`;

let rp3 = `    // 降级: 若汇总失败则从云获取全部交易后计算
    this.transactions = await SyncManager.fetchCloudTransactions(this.currentUser?.store_id) || [];
    const { today } = getReportStats(this.transactions);`;

if (text.includes(pt3)) text = text.replace(pt3, rp3);

// 4. renderTeamReport
let pt4 = `      // 统计逻辑保持使用本地同步后的交易（确保 performSync 已运行）
      const allTxs = loadTransactions();`;

let rp4 = `      // 统计逻辑使用云端获取
      const allTxs = await SyncManager.fetchCloudTransactions(storeId) || [];`;

if (text.includes(pt4)) text = text.replace(pt4, rp4);

// 5. exportBackupJSON
let pt5 = `      transactions: loadTransactions()`;
let rp5 = `      transactions: await SyncManager.fetchCloudTransactions(this.currentStoreId) || []`;

if (text.includes(pt5)) text = text.replace(pt5, rp5);

// 6. exportTransactionsCSV
let pt6 = `    const txs = loadTransactions();`;
let rp6 = `    const txs = await SyncManager.fetchCloudTransactions(this.currentStoreId) || [];`;

if (text.includes(pt6)) text = text.replace(pt6, rp6);

// 7. POSApp constructor
let pt7 = `    this.transactions = loadTransactions(); // 缓存交易记录`;
let rp7 = `    this.transactions = []; // 云端动态获取`;

if (text.includes(pt7)) text = text.replace(pt7, rp7);

fs.writeFileSync(file, text, 'utf8');
console.log('patched successfully');
