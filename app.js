/**
 * 如意收银 - 前端逻辑（优化版 - 合并版）
 */

// ==================== 常量配置 ====================
const TAX_RATE = 0;
const SEARCH_DEBOUNCE_MS = 300;
const TOAST_DURATION_MS = 2200;
const MONTH_TARGET = 9000;

const STORAGE_KEYS = {
  PRODUCTS: 'pos_products',
  TRANSACTIONS: 'pos_transactions',
  LEGACY_STATS: 'pos_today_stats',
  STAT_SUMMARY: 'pos_stat_summary'
};

const DEFAULT_PRODUCTS = [
  { id: '1', name: '矿泉水', price: 2.5, category: '饮料', barcode: '6901028075831', stock: 100 },
  { id: '2', name: '可乐', price: 3.0, category: '饮料', barcode: '6922255451427', stock: 100 },
  { id: '3', name: '雪碧', price: 3.0, category: '饮料', barcode: '6922255450437', stock: 100 },
  { id: '4', name: '橙汁', price: 5.0, category: '饮料', barcode: '6921168509621', stock: 100 },
  { id: '5', name: '咖啡', price: 12.0, category: '饮料', barcode: '8801043021555', stock: 100 },
  { id: '6', name: '奶茶', price: 10.0, category: '饮料', barcode: '6970414320013', stock: 100 },
  { id: '7', name: '面包', price: 6.0, category: '食品', barcode: '6923644240028', stock: 50 },
  { id: '8', name: '三明治', price: 15.0, category: '食品', barcode: '6921168518227', stock: 50 },
  { id: '9', name: '泡面', price: 5.5, category: '食品', barcode: '6920152400018', stock: 50 },
  { id: '10', name: '薯片', price: 8.0, category: '零食', barcode: '6901668002013', stock: 50 },
  { id: '11', name: '巧克力', price: 12.0, category: '零食', barcode: '6923644240219', stock: 50 },
  { id: '12', name: '口香糖', price: 5.0, category: '零食', barcode: '4009900462556', stock: 200 },
  { id: '13', name: '纸巾', price: 3.0, category: '日用品', barcode: '6902952612345', stock: 100 },
  { id: '14', name: '电池', price: 10.0, category: '日用品', barcode: '4902508007016', stock: 100 },
  { id: '15', name: '打火机', price: 2.0, category: '日用品', barcode: '6901234567890', stock: 100 },
];

// ==================== 工具函数 ====================

function getTxAmount(tx) {
  if (!tx) return 0;
  let amt = parseFloat(tx.total);
  if (!isNaN(amt)) return amt;
  amt = parseFloat(tx.amount);
  if (!isNaN(amt)) return amt;
  return 0;
}

function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

function formatPrice(price) {
  return Number(price || 0).toFixed(2);
}

function showToast(elementId, duration = TOAST_DURATION_MS) {
  const toast = document.getElementById(elementId);
  if (!toast) return;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), duration);
}

function safeJsonParse(str, defaultValue = null) {
  try {
    return str ? JSON.parse(str) : defaultValue;
  } catch {
    return defaultValue;
  }
}

function getDeviceId() {
  let id = localStorage.getItem('pos_device_id');
  if (!id) {
    id = 'DEV-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9).toUpperCase();
    localStorage.setItem('pos_device_id', id);
  }
  return id;
}

// ==================== 数据持久化 ====================

function loadProducts() {
  const raw = localStorage.getItem(STORAGE_KEYS.PRODUCTS);
  return safeJsonParse(raw, JSON.parse(JSON.stringify(DEFAULT_PRODUCTS)));
}

function saveProducts(products) {
  localStorage.setItem(STORAGE_KEYS.PRODUCTS, JSON.stringify(products));
}

function loadTransactions() {
  const raw = localStorage.getItem(STORAGE_KEYS.TRANSACTIONS);
  return safeJsonParse(raw, []);
}

function saveTransactions(txs) {
  localStorage.setItem(STORAGE_KEYS.TRANSACTIONS, JSON.stringify(txs));
}

function addTransaction(items, total, paymentDetails = {}) {
  const txs = loadTransactions();
  const id = 'TX' + Date.now();
  txs.push({
    id,
    time: Date.now(),
    items: items.map(item => ({
      name: item.product.name,
      price: item.product.price,
      qty: item.qty,
      subtotal: item.product.price * item.qty
    })),
    total,
    amount: total, // 保持兼容性
    payment: {
      method: paymentDetails.method || 'scan',
      received: paymentDetails.received || total,
      change: paymentDetails.change || 0
    },
    processed_by: paymentDetails.processedBy || '未知'
  });
  saveTransactions(txs);
  updateStatSummary({ id, time: Date.now(), amount: total });
  return id;
}

function loadStatSummary() {
  const raw = localStorage.getItem(STORAGE_KEYS.STAT_SUMMARY);
  return safeJsonParse(raw, {});
}

function saveStatSummary(summary) {
  localStorage.setItem(STORAGE_KEYS.STAT_SUMMARY, JSON.stringify(summary));
}

function updateStatSummary(tx) {
  const summary = loadStatSummary();
  const d = new Date(tx.time);
  const year = d.getFullYear();
  const month = d.getMonth() + 1;
  const day = d.getDate();

  const keyYear = `y_${year}`;
  const keyMonth = `m_${year}_${month}`;
  const keyDay = `d_${year}_${month}_${day}`;

  const updateKey = (key) => {
    if (!summary[key]) summary[key] = { amount: 0, count: 0 };
    summary[key].amount += tx.amount;
    summary[key].count += 1;
  };

  updateKey(keyYear);
  updateKey(keyMonth);
  updateKey(keyDay);

  saveStatSummary(summary);
}

function rebuildStatSummary() {
  const txs = loadTransactions();
  const summary = {};
  txs.forEach(tx => {
    const d = new Date(tx.time);
    const y = d.getFullYear();
    const m = d.getMonth() + 1;
    const day = d.getDate();
    const amt = getTxAmount(tx); // 兼容 total 和 amount 字段，并防 NaN

    const keys = [`y_${y}`, `m_${y}_${m}`, `d_${y}_${m}_${day}`];
    keys.forEach(key => {
      if (!summary[key]) summary[key] = { amount: 0, count: 0 };
      summary[key].amount += amt;
      summary[key].count += 1;
    });
  });
  saveStatSummary(summary);
}

function getTransactionHistory(txs, filter = 'all', searchKeyword = '') {
  const now = new Date();

  return txs.filter(tx => {
    // 时间筛选
    const txDate = new Date(tx.time);
    let matchTime = true;

    if (filter === 'today') {
      const todayStart = new Date(now);
      todayStart.setHours(0, 0, 0, 0);
      matchTime = txDate >= todayStart;
    } else if (filter === 'week') {
      const weekStart = new Date(now);
      weekStart.setDate(now.getDate() - ((now.getDay() + 6) % 7));
      weekStart.setHours(0, 0, 0, 0);
      matchTime = txDate >= weekStart;
    } else if (filter === 'month') {
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
      matchTime = txDate >= monthStart;
    }

    // 商品名称搜索
    let matchSearch = true;
    if (searchKeyword && tx.items) {
      const kw = searchKeyword.toLowerCase();
      matchSearch = tx.items.some(item =>
        item.name && item.name.toLowerCase().includes(kw)
      );
    }

    return matchTime && matchSearch;
  }).reverse(); // 最新的在前面
}

function migrateLegacyStats() {
  const txs = loadTransactions();
  if (txs.length > 0) return;

  const raw = localStorage.getItem(STORAGE_KEYS.LEGACY_STATS);
  const data = safeJsonParse(raw);

  if (data && data.amount > 0 && data.date === new Date().toISOString().slice(0, 10)) {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const n = Math.max(1, data.orders || 1);
    const amt = data.amount / n;

    for (let i = 0; i < n; i++) {
      txs.push({ amount: amt, time: todayStart.getTime() });
    }
    saveTransactions(txs);
  }
}

// ==================== 云同步管理 ====================

const API_BASE = 'http://127.0.0.1:3000/api/v1';

class SyncManager {
  static onSessionExpired = null;

  static get authHeaders() {
    const user = safeJsonParse(localStorage.getItem('pos_user'), null);
    const headers = { 'Content-Type': 'application/json' };
    if (user && user.token) {
      headers['Authorization'] = `Bearer ${user.token}`;
    }
    return headers;
  }

  static async request(path, options = {}) {
    try {
      const url = path.startsWith('http') ? path : `${API_BASE}${path}`;
      const headers = { ...this.authHeaders, ...options.headers };
      const resp = await fetch(url, { ...options, headers });

      if (resp.status === 401) {
        // Try token refresh before giving up
        const refreshed = await this.tryRefreshToken();
        if (refreshed) {
          // Retry the original request with new token
          const newHeaders = { ...this.authHeaders, ...options.headers };
          const retryResp = await fetch(url, { ...options, headers: newHeaders });
          if (retryResp.status === 401) {
            if (this.onSessionExpired) this.onSessionExpired();
            return { code: 401, message: '登录已失效，请重新登录' };
          }
          return await retryResp.json();
        }

        console.warn('Unauthorized: Session expired.');
        if (this.onSessionExpired) this.onSessionExpired();
        return { code: 401, message: '登录已失效，请重新登录' };
      }

      return await resp.json();
    } catch (err) {
      console.warn(`Request to ${path} failed:`, err);
      return { code: 500, message: '网络异常，请稍后重试' };
    }
  }

  static async tryRefreshToken() {
    const user = safeJsonParse(localStorage.getItem('pos_user'), null);
    if (!user || !user.token) return false;

    // Decode JWT to check expiry (JWT payload is base64url encoded)
    try {
      const payload = JSON.parse(atob(user.token.split('.')[1]));
      const expiresAt = (payload.exp || 0) * 1000; // Convert to ms
      const now = Date.now();

      // Only refresh if token is expired or about to expire within 1 day
      if (expiresAt > now + 86400000) return true; // Still valid for > 1 day
      if (expiresAt < now - 86400000 * 7) return false; // Expired too long ago, don't refresh
    } catch {
      return false;
    }

    try {
      const resp = await fetch(`${API_BASE}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${user.token}` }
      });
      if (resp.ok) {
        const result = await resp.json();
        if (result.code === 200 && result.data && result.data.token) {
          user.token = result.data.token;
          localStorage.setItem('pos_user', JSON.stringify(user));
          console.log('Token refreshed successfully');
          return true;
        }
      }
    } catch {
      // Refresh failed silently
    }
    return false;
  }

  static async syncProducts(products) {
    return this.request('/products/sync', {
      method: 'POST',
      body: JSON.stringify({ products })
    });
  }

  static async deleteProduct(productId) {
    return this.request(`/products/${productId}`, {
      method: 'DELETE'
    });
  }

  static async fetchCloudProducts(storeId) {
    const path = storeId ? `/products?store_id=${storeId}` : '/products';
    const result = await this.request(path);
    return result.code === 200 ? result.data : null;
  }

  static async fetchStores() {
    const result = await this.request('/stores');
    return result.code === 200 ? result.data : null;
  }

  static async login(merchantId, username, password) {
    return this.request('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ merchantId, username, password })
    });
  }

  static async getMe() {
    return this.request('/auth/me');
  }

  static async changePassword(oldPassword, newPassword) {
    return this.request('/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ oldPassword, newPassword })
    });
  }

  static async logAudit(action, details) {
    return this.request('/audit', {
      method: 'POST',
      body: JSON.stringify({ action, details })
    });
  }

  // ---- Phase 2 APIs ----

  static async createOrder(payload) {
    return this.request('/orders', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
  }

  static async replayOrders(orders) {
    return this.request('/orders/replay', {
      method: 'POST',
      body: JSON.stringify({ orders })
    });
  }

  static async requestRefund(orderId, reason) {
    return this.request('/refunds', {
      method: 'POST',
      body: JSON.stringify({ order_id: orderId, reason })
    });
  }

  static async approveRefund(refundId) {
    return this.request(`/refunds/${refundId}/approve`, { method: 'PATCH' });
  }

  static async rejectRefund(refundId) {
    return this.request(`/refunds/${refundId}/reject`, { method: 'PATCH' });
  }

  static async fetchRefunds(storeId, status) {
    let path = '/refunds';
    const params = [];
    if (storeId) params.push(`store_id=${storeId}`);
    if (status) params.push(`status=${status}`);
    if (params.length) path += '?' + params.join('&');
    const result = await this.request(path);
    return result.code === 200 ? result.data : [];
  }

  static async adjustInventory(payload) {
    return this.request('/inventory/adjust', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
  }

  static async fetchReportSummary(storeId, startTime, endTime) {
    let path = '/reports/summary';
    const params = [];
    if (storeId) params.push(`store_id=${storeId}`);
    if (startTime) params.push(`start_time=${startTime}`);
    if (endTime) params.push(`end_time=${endTime}`);
    if (params.length) path += '?' + params.join('&');
    const result = await this.request(path);
    return result.code === 200 ? result.data : null;
  }

  static async fetchCloudTransactions(storeId, filters = {}) {
    let path = '/transactions';
    const params = new URLSearchParams();
    if (storeId) params.set('store_id', storeId);
    if (filters.start_time) params.set('start_time', filters.start_time);
    if (filters.end_time) params.set('end_time', filters.end_time);
    if (filters.status) params.set('status', filters.status);

    const query = params.toString();
    if (query) path += '?' + query;
    const result = await this.request(path);
    return result.code === 200 ? result.data : [];
  }

  static async fetchCloudOrders(filters = {}) {
    let path = '/orders';
    const params = new URLSearchParams();
    if (filters.store_id) params.set('store_id', filters.store_id);
    if (filters.start_time) params.set('start_time', filters.start_time);
    if (filters.end_time) params.set('end_time', filters.end_time);
    if (filters.status) params.set('status', filters.status);
    if (filters.order_id) params.set('order_id', filters.order_id);
    
    const query = params.toString();
    if (query) path += '?' + query;
    const result = await this.request(path);
    return result.code === 200 ? result.data : [];
  }

  static async fetchSalesReport(filters = {}) {
    let path = '/reports/sales';
    const params = [];
    if (filters.store_id) params.push(`store_id=${filters.store_id}`);
    if (filters.start_time) params.push(`start_time=${filters.start_time}`);
    if (filters.end_time) params.push(`end_time=${filters.end_time}`);
    if (params.length) path += '?' + params.join('&');
    const result = await this.request(path);
    return result.code === 200 ? result.data : [];
  }

  static async fetchProductRanking(filters = {}) {
    let path = '/reports/products';
    const params = [];
    if (filters.store_id) params.push(`store_id=${filters.store_id}`);
    if (filters.start_time) params.push(`start_time=${filters.start_time}`);
    if (filters.end_time) params.push(`end_time=${filters.end_time}`);
    if (filters.limit) params.push(`limit=${filters.limit}`);
    if (params.length) path += '?' + params.join('&');
    const result = await this.request(path);
    return result.code === 200 ? result.data : [];
  }

  static async fetchStaffPerformance(filters = {}) {
    let path = '/reports/staff';
    const params = [];
    if (filters.store_id) params.push(`store_id=${filters.store_id}`);
    if (filters.start_time) params.push(`start_time=${filters.start_time}`);
    if (filters.end_time) params.push(`end_time=${filters.end_time}`);
    if (params.length) path += '?' + params.join('&');
    const result = await this.request(path);
    return result.code === 200 ? result.data : [];
  }

  static async createPayment(orderId, amount, method) {
    return this.request('/payments/create', {
      method: 'POST',
      body: JSON.stringify({ order_id: orderId, amount, method })
    });
  }

  static async fetchHourlyReport(storeId, startTime, endTime) {
    let path = '/reports/hourly';
    const params = [];
    if (storeId) params.push(`store_id=${storeId}`);
    if (startTime) params.push(`start_time=${startTime}`);
    if (endTime) params.push(`end_time=${endTime}`);
    if (params.length) path += '?' + params.join('&');
    const result = await this.request(path);
    return result.code === 200 ? result.data : [];
  }

  static async fetchReconciliation(filters = {}) {
    let path = '/reports/reconciliation';
    const params = new URLSearchParams();
    if (filters.store_id) params.set('store_id', filters.store_id);
    if (filters.start_time) params.set('start_time', filters.start_time);
    if (filters.end_time) params.set('end_time', filters.end_time);

    const query = params.toString();
    if (query) path += '?' + query;
    const result = await this.request(path);
    return result.code === 200 ? result.data : [];
  }

  static async fetchReconciliationDetails(filters = {}) {
    let path = '/reports/reconciliation/orders';
    const params = new URLSearchParams();
    if (filters.store_id) params.set('store_id', filters.store_id);
    if (filters.start_time) params.set('start_time', filters.start_time);
    if (filters.end_time) params.set('end_time', filters.end_time);

    const query = params.toString();
    if (query) path += '?' + query;
    const result = await this.request(path);
    return result.code === 200 ? result.data : [];
  }

  static async fetchAuditLogs(filters = {}) {
    let path = '/audit';
    const params = new URLSearchParams();
    if (filters.store_id) params.set('store_id', filters.store_id);
    if (filters.action) params.set('action', filters.action);
    if (filters.start_time) params.set('start_time', filters.start_time);
    if (filters.end_time) params.set('end_time', filters.end_time);
    if (filters.user_id) params.set('user_id', filters.user_id);
    if (filters.username) params.set('username', filters.username);
    if (filters.limit) params.set('limit', filters.limit);

    const query = params.toString();
    if (query) path += '?' + query;
    const result = await this.request(path);
    return result.code === 200 ? result.data : [];
  }
}

// ==================== 业务逻辑 ====================

function computeCartTotal(items, discounts = [], taxRate = TAX_RATE) {
  const subtotalVal = items.reduce((sum, c) => {
    const price = c.sku ? c.sku.price : c.product.price;
    return sum + (parseFloat(price) || 0) * (c.qty || 0);
  }, 0);

  let discountTotal = 0;
  if (discounts?.length) {
    for (const d of discounts) {
      if (typeof d.percent === 'number') {
        discountTotal += subtotalVal * d.percent;
      } else if (typeof d.amount === 'number') {
        discountTotal += d.amount;
      }
    }
  }

  const subtotalAfterDiscount = Math.max(0, subtotalVal - discountTotal);
  const tax = subtotalAfterDiscount * taxRate;
  const total = subtotalAfterDiscount + tax;

  return { subtotal: subtotalVal, discountTotal, tax, total, subtotalAfterDiscount };
}

function getCategories(products) {
  const set = new Set(products.map((p) => p.category));
  return ['全部', ...Array.from(set)];
}

function getFilteredProducts(products, category, keyword) {
  return products.filter((p) => {
    const matchCat = category === '全部' || p.category === category;
    const kw = keyword.toLowerCase();
    const matchSearch = !keyword ||
      p.name.toLowerCase().includes(kw) ||
      (p.barcode && p.barcode.includes(kw));
    return matchCat && matchSearch;
  });
}

// ==================== 日期筛选和数据统计 ====================

function getFilteredStats(txs, year, month, day) {
  const summary = loadStatSummary();

  // 优先从汇总表中读取，以提升速度
  // 注意：要检查 amount 不是 NaN，避免缓存了旧的坏数据
  if (parseInt(day) !== 0) {
    const key = `d_${year}_${month}_${day}`;
    if (summary[key] && !isNaN(summary[key].amount)) return summary[key];
  } else if (parseInt(month) !== 0) {
    const key = `m_${year}_${month}`;
    if (summary[key] && !isNaN(summary[key].amount)) return summary[key];
  } else {
    const key = `y_${year}`;
    if (summary[key] && !isNaN(summary[key].amount)) return summary[key];
  }

  // 如果没有汇总或汇总数据异常，则回退到遍历逻辑
  let filteredAmount = 0;
  let filteredCount = 0;

  txs.forEach((tx) => {
    const amount = getTxAmount(tx); // 兼容 total 和 amount 字段，防 NaN
    const d = new Date(tx.time);
    const matchYear = d.getFullYear() === parseInt(year);
    const matchMonth = parseInt(month) === 0 || d.getMonth() + 1 === parseInt(month);
    const matchDay = parseInt(day) === 0 || d.getDate() === parseInt(day);

    if (matchYear && matchMonth && matchDay) {
      filteredAmount += amount;
      filteredCount += 1;
    }
  });

  return { amount: filteredAmount, count: filteredCount };
}

function getDailySalesData(txs, year, month) {
  const daysInMonth = new Date(year, month, 0).getDate();
  const dailyData = new Array(daysInMonth).fill(0);

  txs.forEach((tx) => {
    const amount = getTxAmount(tx); // 兼容 total 和 amount 字段，防 NaN
    const d = new Date(tx.time);
    if (d.getFullYear() === parseInt(year) && d.getMonth() + 1 === parseInt(month)) {
      const day = d.getDate();
      dailyData[day - 1] += amount;
    }
  });

  return dailyData;
}

function updateDayOptions(year, month) {
  const daySelect = document.getElementById('filterDay');
  if (!daySelect) return;

  const daysInMonth = month === 0 ? 31 : new Date(year, month, 0).getDate();
  let options = '<option value="0">全月</option>';

  for (let i = 1; i <= daysInMonth; i++) {
    options += `<option value="${i}">${i}日</option>`;
  }

  daySelect.innerHTML = options;
}


// ==================== 应用状态 ====================

class POSApp {
  constructor() {
    this.products = loadProducts();
    this.transactions = []; // 云端动态获取
    this.cart = [];
    this.currentCategory = '全部';
    this.searchKeyword = '';
    this.lastOrder = { qty: 0, amount: 0 };
    this.editingProductId = null;
    this.currentUser = safeJsonParse(localStorage.getItem('pos_user'), null);

    // Barcode scanner state
    this._barcodeBuffer = '';
    this._lastBarcodeKeyTime = 0;

    // 分页状态
    this.historyPage = 1;
    this.historyPageSize = 20;
    this.filteredHistory = [];

    this.isOnline = false;
    this.syncTimer = null;
    this.stores = [];
    this.currentStoreId = null; 
    this.pendingOrders = safeJsonParse(localStorage.getItem('pending_orders'), []);

    this.currentOrderPayments = []; // 混合支付记录

    this.dom = {
      productsGrid: document.getElementById('productsGrid'),
      categoriesEl: document.getElementById('categories'),
      cartList: document.getElementById('cartList'),
      searchInput: document.getElementById('searchInput'),
      btnSettle: document.getElementById('btnSettle'),
      settleModal: document.getElementById('settleModal'),
      receiptPreview: document.getElementById('receiptPreview'),
      paymentAmountEl: document.getElementById('paymentAmount'),
      btnCancelSettle: document.getElementById('btnCancelSettle'),
      btnConfirmSettle: document.getElementById('btnConfirmSettle'),
      toast: document.getElementById('toast'),
      toastAddProduct: document.getElementById('toastAddProduct'),
      posSection: document.getElementById('posSection'),
      addProductSection: document.getElementById('addProductSection'),
      addProductForm: document.getElementById('addProductForm'),
      productCategorySelect: document.getElementById('productCategory'),
      productCategoryNew: document.getElementById('productCategoryNew'),
      reportSection: document.getElementById('reportSection'),
      productsSection: document.getElementById('productsSection'),
      productsPageCategories: document.getElementById('productsPageCategories'),
      productsPageGrid: document.getElementById('productsPageGrid'),
      productsSearch: document.getElementById('productsSearch'),
      historySection: document.getElementById('historySection'),
      historyList: document.getElementById('historyList'),
      historySearch: document.getElementById('historySearch'),
      historyDateFilter: document.getElementById('historyDateFilter'),
      historyPagination: document.getElementById('historyPagination'),
      btnLoadMoreHistory: document.getElementById('btnLoadMoreHistory'),
      refundsSection: document.getElementById('refundsSection'),
      refundsList: document.getElementById('refundsList'),
      refundsStatusFilter: document.getElementById('refundsStatusFilter'),
      refundsStoreFilter: document.getElementById('refundsStoreFilter'),
      settingsSection: document.getElementById('settingsSection'),
      skuModal: document.getElementById('skuModal'),
      btnCancelSku: document.getElementById('btnCancelSku'),
      teamReportSection: document.getElementById('teamReportSection'),
      teamReportGrid: document.getElementById('teamReportGrid'),
      subordinateModal: document.getElementById('subordinateModal'),
      subordinateForm: document.getElementById('subordinateForm'),
      btnAddSubordinate: document.getElementById('btnAddSubordinate'),
      btnCancelSub: document.getElementById('btnCancelSub'),
      changePasswordModal: document.getElementById('changePasswordModal'),
      changePasswordForm: document.getElementById('changePasswordForm'),
      inventoryAdjustModal: document.getElementById('inventoryAdjustModal'),
      inventoryAdjustForm: document.getElementById('inventoryAdjustForm'),
      btnInventoryAdjust: document.getElementById('btnInventoryAdjust'),
      btnCancelAdjust: document.getElementById('btnCancelAdjust'),
      initForm: document.getElementById('initForm'),
      initError: document.getElementById('initError'),
      
      // 第五阶段新增
      reconciliationSection: document.getElementById('reconciliationSection'),
      reconTableBody: document.getElementById('reconTableBody'),
      btnReconFilter: document.getElementById('btnReconFilter'),
      auditSection: document.getElementById('auditSection'),
      auditTableBody: document.getElementById('auditTableBody'),
      auditStoreFilter: document.getElementById('auditStoreFilter'),
      auditActionFilter: document.getElementById('auditActionFilter'),
      btnAuditFilter: document.getElementById('btnAuditFilter'),
      navReconciliation: document.getElementById('navReconciliation'),
      navAudit: document.getElementById('navAudit'),
      paymentRecordList: document.getElementById('paymentRecordList'),
      paidAmountEl: document.getElementById('paidAmount'),
      remainingAmountEl: document.getElementById('remainingAmount'),
      mixPaymentMethod: document.getElementById('mixPaymentMethod'),
      mixPaymentAmount: document.getElementById('mixPaymentAmount'),
      btnAddPaymentLine: document.getElementById('btnAddPaymentLine')
    };
  }

  init() {
    // 绑定会话失效回调
    SyncManager.onSessionExpired = () => this.handleSessionExpired();

    migrateLegacyStats();
    this.migrateToSKUs(); // 迁移 SKU 数据
    // 每次启动都重建汇总表，确保清除旧的 NaN 数据
    rebuildStatSummary();
    this.updateCategorySelect();
    this.renderCategories();
    this.renderProducts();
    this.renderProductsPage();
    this.updateStatsUI();
    this.updateLastOrderUI();
    this.bindEvents();
    this.updateCartUI();
    this.checkStockLevels();

    // 尝试启动后端
    if (window.electronAPI) {
      window.electronAPI.startBackend();
    }

    // 初始化身份验证
    this.checkInitializationStatus();
  }

  async checkInitializationStatus() {
    const resp = await SyncManager.request('/auth/init-status');
    if (resp.code === 200 && resp.data) {
      if (resp.data.merchantCode || resp.data.merchantId) {
        localStorage.setItem('pos_merchant_code', resp.data.merchantCode || resp.data.merchantId);
      }
      if (resp.data.merchantId) {
        localStorage.setItem('pos_merchant_id', resp.data.merchantId);
      }
    }
    if (resp.code === 200 && resp.data.initialized === false) {
      this.dom.initOverlay.style.display = 'flex';
      document.getElementById('loginOverlay').classList.remove('show');
    } else {
      this.dom.initOverlay.style.display = 'none';
      // System initialized, hide public registration option
      const btnShowReg = document.getElementById('btnShowRegister');
      if (btnShowReg) btnShowReg.style.display = 'none';
      this.checkAuth();
    }
  }

  async checkAuth() {
    if (!this.currentUser || !this.currentUser.token) {
      document.getElementById('loginOverlay').classList.add('show');
      // Auto-fill merchant ID from localStorage (set by setup wizard)
      const savedMerchantId = localStorage.getItem('pos_merchant_code') || localStorage.getItem('pos_merchant_id');
      const merchantEl = document.getElementById('merchantId');
      if (savedMerchantId && merchantEl && !merchantEl.value) {
        merchantEl.value = savedMerchantId;
      }
      return;
    }

    // Proactively fetch latest user profile to verify token and restore context
    const resp = await SyncManager.getMe();
    if (resp.code === 200) {
      // Merge latest profile with existing token
      this.currentUser = { ...this.currentUser, ...resp.data };
      localStorage.setItem('pos_user', JSON.stringify(this.currentUser));

      document.getElementById('loginOverlay').classList.remove('show');
      this.updateUserUI();

      // Forced Password Change Logic
      if (this.currentUser.must_change_password) {
        this.dom.changePasswordModal.classList.add('show');
      } else {
        this.dom.changePasswordModal.classList.remove('show');
      }

      // 如果不是离线模式，启动同步（防止重复启动）
      if (!this.isOffline && !this.syncTimer) {
        this.startSyncTimer();
        this.initialCloudPull().then(() => {
          if (this.currentView === 'teamReport') {
            this.renderTeamReport();
          }
        });
      }
    } else if (resp.code === 401) {
      // Handled by onSessionExpired but calling here for safety
      this.handleSessionExpired();
    } else {
      // Network error or other issues, fall back to cached info but mark offline? 
      // For now, trust the cache but warn
      console.warn('Could not verify session with server, using cached profile.');
      document.getElementById('loginOverlay').classList.remove('show');
      this.updateUserUI();
    }
  }

  handleSessionExpired() {
    this.currentUser = null;
    localStorage.removeItem('pos_user');
    this.resetStoreContext();
    document.getElementById('loginOverlay').classList.add('show');
    const errorEl = document.getElementById('loginError');
    if (errorEl) errorEl.textContent = '登录已失效，请重新登录';

    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
  }

  resetStoreContext() {
    this.currentStoreId = null;
    this.stores = [];

    const switcher = document.getElementById('storeSwitcher');
    if (switcher) {
      switcher.innerHTML = '<option value="">所有门店</option>';
      switcher.value = '';
    }
  }

  syncStoreScopeWithUser() {
    const switcher = document.getElementById('storeSwitcher');

    if (!this.currentUser) {
      this.currentStoreId = null;
      if (switcher) switcher.value = '';
      return;
    }

    if (this.currentUser.role === 'merchant_admin') {
      if (switcher) switcher.value = this.currentStoreId || '';
      return;
    }

    this.currentStoreId = this.currentUser.store_id || null;
    if (switcher) switcher.value = '';
  }


  async login(e) {
    e.preventDefault();
    const btn = document.getElementById('btnLogin');
    const merchantEl = document.getElementById('merchantId');
    const userEl = document.getElementById('username');
    const passEl = document.getElementById('password');
    const errorEl = document.getElementById('loginError');

    const merchantId = merchantEl.value.trim();
    const username = userEl.value.trim();
    const password = passEl.value.trim();

    if (!merchantId || !username || !password) {
      errorEl.textContent = '请输入完整登录信息';
      return;
    }

    btn.disabled = true;
    btn.textContent = '登录中...';

    const result = await SyncManager.login(merchantId, username, password);

    if (result.code === 200) {
      // 1. Save initial token/user
      this.currentUser = result.data;
      localStorage.setItem('pos_user', JSON.stringify(this.currentUser));
      if (result.data.merchant_code) {
        localStorage.setItem('pos_merchant_code', result.data.merchant_code);
      }

      // 2. Fetch full profile via /me to ensure context is correct
      const meResult = await SyncManager.getMe();
      if (meResult.code === 200) {
        this.currentUser = { ...this.currentUser, ...meResult.data };
        localStorage.setItem('pos_user', JSON.stringify(this.currentUser));

        errorEl.textContent = '';
        merchantEl.value = '';
        userEl.value = '';
        passEl.value = '';
        this.checkAuth();
      } else {
        errorEl.textContent = '获取用户信息失败: ' + meResult.message;
      }
    } else {
      errorEl.textContent = result.message || '登录失败';
      if (result.code === 500 && window.electronAPI) {
        window.electronAPI.startBackend();
      }
    }

    btn.disabled = false;
    btn.textContent = '立即登录';
  }

  async handleInitSetup(e) {
    e.preventDefault();
    const btn = document.getElementById('btnDoInit');
    const merchantName = document.getElementById('initMerchantName').value.trim();
    const adminName = document.getElementById('initAdminName').value.trim();
    const username = document.getElementById('initUsername').value.trim();
    const password = document.getElementById('initPassword').value.trim();
    const storeName = document.getElementById('initStoreName').value.trim();
    const deviceName = document.getElementById('initDeviceName').value.trim();
    const deviceId = getDeviceId();

    btn.disabled = true;
    btn.textContent = '初始化中...';

    const result = await SyncManager.request('/auth/init-setup', {
      method: 'POST',
      body: JSON.stringify({
        merchantName,
        adminName,
        username,
        password,
        storeName,
        deviceId,
        deviceName
      })
    });

    if (result.code === 200) {
      // Save merchant ID for auto-fill on login page
      if (result.data && (result.data.merchantCode || result.data.merchantId)) {
        localStorage.setItem('pos_merchant_code', result.data.merchantCode || result.data.merchantId);
      }
      if (result.data && result.data.merchantId) {
        localStorage.setItem('pos_merchant_id', result.data.merchantId);
      }
      alert('系统初始化完成！请使用设置的管理员账号登录。');
      this.dom.initOverlay.style.display = 'none';
      this.checkInitializationStatus(); // Check status again to show login
    } else {
      this.dom.initError.textContent = result.message || '初始化失败';
      btn.disabled = false;
      btn.textContent = '完成初始化并进入系统';
    }
  }

  async handlePublicRegister(e) {
    e.preventDefault();
    const btn = document.getElementById('btnDoRegister');
    const shopName = document.getElementById('regShopName').value.trim();
    const name = document.getElementById('regName').value.trim();
    const username = document.getElementById('regUsername').value.trim();
    const password = document.getElementById('regPassword').value.trim();
    const errorEl = document.getElementById('loginError');

    if (password.length < 6) {
      errorEl.textContent = '密码至少需要6位字符';
      return;
    }

    btn.disabled = true;
    btn.textContent = '开店中...';

    try {
      const resp = await fetch(`${API_BASE}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shopName, name, username, password })
      });
      const result = await resp.json();

      if (result.code === 200) {
        alert('注册成功！正在为您跳转登录...');
        // 切换回登录界面并填充账号
        document.getElementById('registerForm').style.display = 'none';
        document.getElementById('loginForm').style.display = 'block';
        document.getElementById('btnShowRegister').style.display = 'block';
        document.getElementById('btnShowLogin').style.display = 'none';
        document.getElementById('username').value = username;
        errorEl.textContent = '';
      } else {
        errorEl.textContent = result.message || '注册失败';
      }
    } catch (err) {
      errorEl.textContent = '网络请求失败，请检查后端服务';
    } finally {
      btn.disabled = false;
      btn.textContent = '创建账号并开店';
    }
  }

  logout() {
    this.currentUser = null;
    localStorage.removeItem('pos_user');
    this.resetStoreContext();
    this.checkAuth();
  }

  updateUserUI() {
    this.syncStoreScopeWithUser();

    const nameEl = document.getElementById('displayUserName');
    const roleEl = document.getElementById('displayUserRole');
    if (nameEl) nameEl.textContent = this.currentUser.name;

    const roleMap = {
      merchant_admin: '总部管理员',
      store_manager: '门店店长',
      cashier: '收银员'
    };
    if (roleEl) roleEl.textContent = roleMap[this.currentUser.role] || '未知角色';

    // 权限与菜单显示逻辑
    const role = this.currentUser.role;
    const isGuest = this.currentUser.id === 'u0';

    const permissions = {
      merchant_admin: ['pos', 'addProduct', 'products', 'history', 'report', 'teamReport', 'reconciliation', 'audit', 'settings'],
      store_manager: ['pos', 'addProduct', 'products', 'history', 'reconciliation', 'audit', 'teamReport'],
      cashier: ['pos', 'history', 'cashierReport']
    };

    const allowedViews = isGuest ? ['pos', 'history', 'cashierReport'] : (permissions[role] || ['pos']);

    document.querySelectorAll('.nav-item').forEach(el => {
      const view = el.dataset.view;
      el.style.display = allowedViews.includes(view) ? 'flex' : 'none';
    });

    // 离线标识
    const syncStatusEl = document.getElementById('syncStatus');
    if (this.isOffline) {
      syncStatusEl.textContent = '● 离线模式';
      syncStatusEl.className = 'sync-status offline';
    } else {
      syncStatusEl.textContent = '● 在线模式';
      syncStatusEl.className = 'sync-status online';
    }

    // 门店切换器控制 (仅总部管理员可见)
    const storeSelectorArea = document.getElementById('storeSelectorArea');
    if (storeSelectorArea) {
      storeSelectorArea.style.display = role === 'merchant_admin' ? 'block' : 'none';
      if (role === 'merchant_admin' && this.stores.length === 0) {
        this.loadStores();
      }
    }

    // 如果当前处于无权访问页面，强制跳转到收银台
    // 库存调整按钮权限
    const btnAdj = document.getElementById('btnInventoryAdjust');
    if (btnAdj) btnAdj.style.display = ['merchant_admin', 'store_manager'].includes(role) ? 'inline-flex' : 'none';

    if (!allowedViews.includes(this.currentView)) {
      this.switchView('pos');
    }
  }

  async loadStores() {
    const stores = await SyncManager.fetchStores();
    if (stores) {
      this.stores = stores;
      // 填充切换器
      const switcher = document.getElementById('storeSwitcher');
      if (switcher) {
        switcher.innerHTML = `<option value="">所有门店</option>` + stores.map(s => `
          <option value="${s.id}">${escapeHtml(s.name)}</option>
        `).join('');
      }

      // 填充员工分配模态框
      const subStoreSelect = document.getElementById('subStoreId');
      if (subStoreSelect) {
        subStoreSelect.innerHTML = stores.map(s => `
          <option value="${s.id}">${escapeHtml(s.name)}</option>
        `).join('');
      }

      // 管理员登录后，若未选中门店且有可用门店，自动选中第一家
      if (!this.currentStoreId && stores.length > 0) {
        await this.switchStore(stores[0].id);
      }
    }
  }

  async switchStore(storeId) {
    console.log('Switching to store:', storeId || 'Global');
    this.currentStoreId = storeId || null;

    // 更新当前门店名称显示
    const storeDisplay = document.getElementById('currentStoreDisplay');
    const storeNameEl = document.getElementById('currentStoreName');
    if (storeDisplay && storeNameEl) {
      const store = this.stores.find(s => s.id === storeId);
      if (store) {
        storeNameEl.textContent = store.name;
        storeDisplay.style.display = 'block';
      } else {
        storeDisplay.style.display = 'none';
      }
    }

    // 清空本地缓存并重新拉取
    // 注意：为了简单起见，这里直接调用 initialCloudPull
    // 在生产环境下可能需要更精细的本地缓存管理
    await this.initialCloudPull();

    // 强制刷新当前视图
    this.switchView(this.currentView);
    showToast('toastStoreSwitch'); // 使用专用的门店切换提示
  }

  async initialCloudPull() {
    console.log('Fetching cloud data...');
    const cloudProducts = await SyncManager.fetchCloudProducts(this.currentStoreId);
    const cloudTxs = await SyncManager.fetchCloudOrders({
      store_id: this.currentStoreId || undefined
    });

    if (cloudProducts && cloudProducts.length > 0) {
      console.log('Products pulled from cloud:', cloudProducts.length);
      this.products = cloudProducts;
      saveProducts(this.products);
      this.renderProducts();
      this.updateCategorySelect();
    }

    this.transactions = Array.isArray(cloudTxs) ? cloudTxs : [];
    console.log('Transactions pulled from cloud:', this.transactions.length);
    saveTransactions(this.transactions);
    rebuildStatSummary();
    this.updateStatsUI();
  }

  startSyncTimer() {
    // 防止重复创建计时器
    if (this.syncTimer) return;
    // 每 30 秒自动同步一次
    this.syncTimer = setInterval(() => this.performSync(), 30000);
    // 延迟运行，避免随即半秒内报引起页面闪烁
    setTimeout(() => this.performSync(), 500);
  }

  async replayPendingOrders() {
    if (this.pendingOrders.length === 0) return;
    
    console.log(`Replaying ${this.pendingOrders.length} pending orders via /orders/replay...`);
    try {
      const result = await SyncManager.replayOrders(this.pendingOrders);
      if (result && result.code === 200 && Array.isArray(result.data?.results)) {
        const remaining = [];
        for (let i = 0; i < this.pendingOrders.length; i++) {
          const r = result.data.results[i];
          if (r && (r.code === 200 || r.code === 409)) {
            console.log(`Order ${r.client_tx_id} synced (code ${r.code})`);
          } else {
            remaining.push(this.pendingOrders[i]);
          }
        }
        if (remaining.length !== this.pendingOrders.length) {
          this.pendingOrders = remaining;
          localStorage.setItem('pending_orders', JSON.stringify(this.pendingOrders));
          this.initialCloudPull();
        }
      }
    } catch (err) {
      console.warn('replayPendingOrders error:', err);
    }
  }

  async performSync() {
    // 0. Replay any pending offline orders
    if (this.pendingOrders.length > 0) {
      await this.replayPendingOrders();
    }

    // 1. 推送本地商品数据 (考虑到 SaaS 改造，未来可能也改为实时 API)
    const pResult = await SyncManager.syncProducts(this.products);

    // 2. 拉取云端完整交易记录，保持历史页与统计页口径一致
    const cloudTxs = await SyncManager.fetchCloudOrders({
      store_id: this.currentStoreId || undefined
    });
    const nextTransactions = Array.isArray(cloudTxs) ? cloudTxs : [];
    const changed = JSON.stringify(nextTransactions) !== JSON.stringify(this.transactions);

    if (changed) {
      console.log(`Sync: Cloud has ${nextTransactions.length} transactions, updating local.`);
    }

    this.transactions = nextTransactions;
    saveTransactions(this.transactions);
    rebuildStatSummary();
    this.updateStatsUI();

    // 如果当前正在查看相关报表，自动刷新页面内容
    if (this.currentView === 'teamReport') {
      this.renderTeamReport();
    } else if (this.currentView === 'report') {
      this.updateMainStats();
    } else if (this.currentView === 'history' && changed) {
      this.renderHistory();
    }

    const wasOnline = this.isOnline;
    this.isOnline = !!(pResult && cloudTxs);

    if (this.isOnline !== wasOnline) {
      this.updateSyncStatusUI();
    }
  }

  updateSyncStatusUI() {
    const el = document.getElementById('syncStatus');
    if (el) {
      if (this.isOnline) {
        let statusText = '● 云同步已就绪';
        if (this.pendingOrders.length > 0) {
          statusText = `● 正在同步 (${this.pendingOrders.length})`;
        }
        el.textContent = statusText;
        el.className = 'sync-status online';
      } else {
        const pendingCount = this.pendingOrders.length;
        el.textContent = pendingCount > 0 ? `○ 离线模式 (${pendingCount} 待同步)` : '○ 离线模式';
        el.className = 'sync-status offline';
      }
    }
  }

  async updateStatsUI() {
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const endOfTime = now.getTime();

    try {
      // 获取今日汇总
      const todayData = await SyncManager.fetchReportSummary(this.currentStoreId, startOfDay, endOfTime);
      // 获取月汇总
      const monthData = await SyncManager.fetchReportSummary(this.currentStoreId, startOfMonth, endOfTime);

      const todayCount = todayData?.summary?.order_count || 0;
      const monthCount = monthData?.summary?.order_count || 0;

      const todayCountEl = document.getElementById('todayCount');
      const monthCurrentEl = document.getElementById('monthCurrent');
      const monthTargetEl = document.getElementById('monthTarget');
      const monthProgressEl = document.getElementById('monthProgress');

      if (todayCountEl) todayCountEl.textContent = `今日收银 ${todayCount} 笔`;
      if (monthCurrentEl) monthCurrentEl.textContent = monthCount;
      if (monthTargetEl) monthTargetEl.textContent = MONTH_TARGET;
      if (monthProgressEl) {
        const pct = Math.min(100, (monthCount / MONTH_TARGET) * 100);
        monthProgressEl.style.width = pct + '%';
      }
    } catch (err) {
      console.warn('updateStatsUI from backend failed:', err);
    }
  }

  updateLastOrderUI() {
    const el = document.getElementById('lastOrderText');
    if (el) {
      el.textContent = `上一单共${this.lastOrder.qty}件商品 ¥${formatPrice(this.lastOrder.amount)}`;
    }
  }

  updateCategorySelect() {
    const cats = [...new Set(this.products.map((p) => p.category))].sort();
    const currentVal = this.dom.productCategorySelect?.value;

    if (!this.dom.productCategorySelect) return;

    this.dom.productCategorySelect.innerHTML =
      cats.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('') +
      '<option value="_new_">+ 新建分类</option>';

    if (currentVal && currentVal !== '_new_' && cats.includes(currentVal)) {
      this.dom.productCategorySelect.value = currentVal;
    }
  }

  switchView(viewId) {
    if (!viewId) return;
    this.currentView = viewId;

    this.dom.posSection?.classList.toggle('active', viewId === 'pos');
    this.dom.addProductSection?.classList.toggle('active', viewId === 'addProduct');
    this.dom.reportSection?.classList.toggle('active', viewId === 'report');
    this.dom.productsSection?.classList.toggle('active', viewId === 'products');
    this.dom.historySection?.classList.toggle('active', viewId === 'history');
    this.dom.refundsSection?.classList.toggle('active', viewId === 'refunds');
    this.dom.teamReportSection?.classList.toggle('active', viewId === 'teamReport');
    this.dom.cashierReportSection?.classList.toggle('active', viewId === 'cashierReport');

    document.querySelectorAll('.nav-item[data-view]').forEach((el) => {
      el.classList.toggle('active', el.dataset.view === viewId);
    });

    if (viewId === 'report') this.renderReport();
    if (viewId === 'history') this.renderHistory();
    if (viewId === 'refunds') this.renderRefunds();
    if (viewId === 'teamReport') this.renderTeamReport();
    if (viewId === 'cashierReport') this.renderCashierReport();
    if (viewId === 'reconciliation') this.renderReconciliation();
    if (viewId === 'audit') this.renderAuditLogs();
  }

  async renderReconciliation() {
    const startObj = document.getElementById('reconStartDate');
    const endObj = document.getElementById('reconEndDate');
    
    // 默认今日
    const now = new Date();
    if (!startObj.value) startObj.value = now.toISOString().split('T')[0];
    if (!endObj.value) endObj.value = now.toISOString().split('T')[0];

    const filters = {
      store_id: this.currentStoreId,
      start_time: new Date(startObj.value + ' 00:00:00').getTime(),
      end_time: new Date(endObj.value + ' 23:59:59').getTime()
    };

    const data = await SyncManager.fetchReconciliation(filters);
    const tbody = this.dom.reconTableBody;
    
    if (!data || data.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; padding:20px; color:#999;">暂无对账数据</td></tr>';
      return;
    }

    tbody.innerHTML = data.map(r => `
      <tr>
        <td>${escapeHtml(r.store_name)}</td>
        <td>${r.order_count}</td>
        <td style="font-weight:bold;">¥${formatPrice(r.receivable)}</td>
        <td style="color:#07c160;">¥${formatPrice(r.actual)}</td>
        <td style="color:#e74c3c;">¥${formatPrice(r.refunded)}</td>
        <td style="font-weight:bold; color:${Math.abs(r.discrepancy) > 0.1 ? '#e74c3c' : 'inherit'};">
            ¥${formatPrice(r.discrepancy)}
        </td>
        <td>
            <button class="btn btn-secondary btn-sm btn-recon-details" data-id="${r.store_id}" style="padding:4px 8px; font-size:0.75rem;">查看明细</button>
        </td>
      </tr>
    `).join('');

    tbody.querySelectorAll('.btn-recon-details').forEach(btn => {
      btn.onclick = () => this.renderReconciliationDetails(btn.dataset.id);
    });
  }

  async renderReconciliationDetails(storeId) {
    const startObj = document.getElementById('reconStartDate');
    const endObj = document.getElementById('reconEndDate');
    
    const filters = {
      store_id: storeId,
      start_time: new Date(startObj.value + ' 00:00:00').getTime(),
      end_time: new Date(endObj.value + ' 23:59:59').getTime()
    };

    const data = await SyncManager.fetchReconciliationDetails(filters);
    const tbody = document.getElementById('reconDetailsTableBody');
    const modal = document.getElementById('reconDetailsModal');
    
    if (!data || data.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align:center; padding:20px; color:#999;">暂无异常订单明细</td></tr>';
    } else {
      tbody.innerHTML = data.map(o => `
        <tr>
          <td style="font-size:0.8rem;">${o.id}</td>
          <td style="color:#666; font-size:0.75rem;">${new Date(o.time).toLocaleString()}</td>
          <td>¥${formatPrice(o.receivable)}</td>
          <td>¥${formatPrice(o.actual)}</td>
          <td>¥${formatPrice(o.refunded)}</td>
          <td style="font-weight:bold; color:${Math.abs(o.receivable - o.actual) > 0.1 ? '#e74c3c' : '#07c160'};">
            ¥${formatPrice(o.receivable - o.actual)}
          </td>
          <td><span class="badge" style="background:#eee; color:#333;">${o.status === 'paid' ? '已支付' : o.status === 'partially_refunded' ? '部分退款' : '已全额退款'}</span></td>
        </tr>
      `).join('');
    }

    modal.classList.add('show');
    document.getElementById('btnCloseReconDetails').onclick = () => modal.classList.remove('show');
  }

  async renderAuditLogs() {
    const store_id = this.dom.auditStoreFilter.value;
    const action = this.dom.auditActionFilter.value;
    const username = document.getElementById('auditUserFilter').value;
    const startDate = document.getElementById('auditStartDate').value;
    const endDate = document.getElementById('auditEndDate').value;

    const data = await SyncManager.fetchAuditLogs({
      store_id,
      action,
      username,
      start_time: startDate ? new Date(startDate + ' 00:00:00').getTime() : null,
      end_time: endDate ? new Date(endDate + ' 23:59:59').getTime() : null,
      limit: 100
    });

    const tbody = this.dom.auditTableBody;
    if (!data || data.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; padding:20px; color:#999;">暂无审计记录</td></tr>';
      return;
    }

    // 异常检测规则
    const isAnomalous = (log) => {
      const act = log.action || '';
      const details = log.details || '';
      // 大额退款（>= 500）
      if ((act.includes('REFUND') || act.includes('refund')) && /"amount"\s*:\s*\d{3,}/.test(details)) return { level: 'danger', reason: '大额退款' };
      // 登录失败
      if (act === 'LOGIN_FAILED') return { level: 'warning', reason: '登录失败' };
      // 订单超时取消
      if (act === 'ORDER_TIMEOUT_CANCEL') return { level: 'warning', reason: '订单超时' };
      // 非营业时间操作（0:00-6:00）
      const hour = new Date(log.time).getHours();
      if (hour >= 0 && hour < 6 && !act.includes('TIMEOUT') && !act.includes('LOGIN')) {
        return { level: 'warning', reason: '非营业时间操作' };
      }
      // 频繁取消（同一用户同一天取消>=3次 - 需要上下文，这里简化处理）
      if (act === 'ORDER_CANCEL') return { level: 'info', reason: '订单取消' };
      return null;
    };

    const badgeStyles = {
      danger: 'background:#fff0f0; color:#ee0a24; border:1px solid #ffcdd2;',
      warning: 'background:#fff8e1; color:#ff9800; border:1px solid #ffe0b2;',
      info: 'background:#e3f2fd; color:#1976d2; border:1px solid #bbdefb;'
    };

    tbody.innerHTML = data.map(log => {
      const anomaly = isAnomalous(log);
      const rowStyle = anomaly ? `background:${anomaly.level === 'danger' ? '#fff5f5' : anomaly.level === 'warning' ? '#fffdf5' : '#f5f9ff'};` : '';
      const badgeStyle = anomaly ? badgeStyles[anomaly.level] : 'background:#eee; color:#333;';
      const anomalyTag = anomaly ? ` <span style="font-size:0.7rem; padding:1px 4px; border-radius:3px; ${badgeStyle}">${anomaly.reason}</span>` : '';

      return `
      <tr style="${rowStyle}">
        <td style="color:#666;">${new Date(log.time).toLocaleString()}</td>
        <td>${escapeHtml(log.username || '系统')}</td>
        <td>${escapeHtml(log.store_name || '-')}</td>
        <td><span class="badge" style="${badgeStyle}">${escapeHtml(log.action)}</span>${anomalyTag}</td>
        <td style="font-family:monospace; font-size:0.8rem;">${escapeHtml(log.details)}</td>
      </tr>`;
    }).join('');
  }

  async renderReport() {
    const now = new Date();
    const yearSelect = document.getElementById('filterYear');
    const monthSelect = document.getElementById('filterMonth');

    const year = yearSelect ? parseInt(yearSelect.value) : now.getFullYear();
    const month = monthSelect ? parseInt(monthSelect.value) : now.getMonth() + 1;
    updateDayOptions(year, month);

    // 1. 获取主汇总数据 (顶部大字)
    this.updateMainStatsFromBackend();

    // 2. 获取期间对比数据 (今日/本周/本月)
    const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const weekStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7).getTime();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    
    const [todaySum, weekSum, monthSum] = await Promise.all([
        SyncManager.fetchReportSummary(this.currentStoreId, dayStart, now.getTime()),
        SyncManager.fetchReportSummary(this.currentStoreId, weekStart, now.getTime()),
        SyncManager.fetchReportSummary(this.currentStoreId, monthStart, now.getTime())
    ]);

    const ids = ['reportTodayAmount', 'reportTodayCount', 'reportWeekAmount', 'reportWeekCount', 'reportMonthAmount', 'reportMonthCount'];
    const vals = [
        '¥ ' + formatPrice(todaySum?.summary?.total_sales), 
        (todaySum?.summary?.order_count || 0) + ' 笔', 
        '¥ ' + formatPrice(weekSum?.summary?.total_sales), 
        (weekSum?.summary?.order_count || 0) + ' 笔', 
        '¥ ' + formatPrice(monthSum?.summary?.total_sales), 
        (monthSum?.summary?.order_count || 0) + ' 笔'
    ];
    ids.forEach((id, i) => { const el = document.getElementById(id); if (el) el.textContent = vals[i]; });

    // 3. 渲染图表
    this.renderSalesChart(year, month);
    this.renderHourlyChart(year, month, day);
    
    // 4. 渲染商品和员工排行 (Phase 3 Day 5 新增)
    this.renderProductRanking(year, month);
    this.renderStaffRanking(year, month);
  }

  async renderSalesChart(year, month) {
    const el = document.getElementById('reportSalesChart');
    if (!el) return;

    let start_time, end_time;
    if (month > 0) {
      start_time = new Date(year, month - 1, 1).getTime();
      end_time = new Date(year, month, 0, 23, 59, 59, 999).getTime();
    } else {
      start_time = new Date(year, 0, 1).getTime();
      end_time = new Date(year, 11, 31, 23, 59, 59, 999).getTime();
    }

    const salesTrend = await SyncManager.fetchSalesReport({
       store_id: this.currentStoreId,
       start_time,
       end_time
    });

    if (!salesTrend || salesTrend.length === 0) {
      el.innerHTML = '<div style="height:100px; display:flex; align-items:center; justify-content:center; color:var(--text-muted);">暂无报表数据</div>';
      return;
    }

    const max = Math.max(1, ...salesTrend.map(d => d.total_sales));
    el.innerHTML = salesTrend.map(d => {
       const h = (d.total_sales / max) * 100;
       // Format date for label (extract day if month selected)
       const label = month > 0 ? new Date(d.date).getDate() : (new Date(d.date).getMonth() + 1 + '月');
       return `
          <div class="chart-bar" style="height:${h}%" title="${d.date}: ¥${formatPrice(d.total_sales)}">
             ${d.total_sales > 0 ? `<div class="chart-bar-value">¥${formatPrice(d.total_sales)}</div>` : ''}
             <div class="chart-bar-label">${label}</div>
          </div>
       `;
    }).join('');
  }

  async renderProductRanking(year, month) {
    // 假设页面上有对应容器
    const el = document.getElementById('reportProductRanking');
    if (!el) return;

    const start_time = new Date(year, month - 1, 1).getTime();
    const end_time = new Date(year, month, 0, 23, 59, 59, 999).getTime();

    const ranking = await SyncManager.fetchProductRanking({
       store_id: this.currentStoreId,
       start_time,
       end_time,
       limit: 5
    });

    if (!ranking || ranking.length === 0) {
       el.innerHTML = '<div style="padding:10px; color:var(--text-muted);">暂无排行</div>';
       return;
    }

    el.innerHTML = `
       <table class="ranking-table">
          <thead><tr><th>商品</th><th>数量</th><th>金额</th></tr></thead>
          <tbody>
             ${ranking.map(r => `
                <tr>
                   <td>${escapeHtml(r.name)}</td>
                   <td>${r.total_qty}</td>
                   <td>¥${formatPrice(r.total_revenue)}</td>
                </tr>
             `).join('')}
          </tbody>
       </table>
    `;
  }

  async renderStaffRanking(year, month) {
    const el = document.getElementById('reportStaffRanking');
    if (!el) return;

    const start_time = new Date(year, month - 1, 1).getTime();
    const end_time = new Date(year, month, 0, 23, 59, 59, 999).getTime();

    const ranking = await SyncManager.fetchStaffPerformance({
       store_id: this.currentStoreId,
       start_time,
       end_time
    });

    if (!ranking || ranking.length === 0) {
       el.innerHTML = '<div style="padding:10px; color:var(--text-muted);">暂无绩效</div>';
       return;
    }

    el.innerHTML = `
       <table class="ranking-table">
          <thead><tr><th>员工</th><th>单数</th><th>业绩</th></tr></thead>
          <tbody>
             ${ranking.map(r => `
                <tr>
                   <td>${escapeHtml(r.staff_name || '系统')}</td>
                   <td>${r.order_count}</td>
                   <td>¥${formatPrice(r.total_sales)}</td>
                </tr>
             `).join('')}
          </tbody>
       </table>
    `;
  }

  async renderHourlyChart(year, month, day) {
    const el = document.getElementById('reportHourlyChart');
    if (!el) return;

    let start_time, end_time;
    const now = new Date();
    const y = year || now.getFullYear();
    const m = month || (now.getMonth() + 1);
    const d = (day !== undefined && day !== null) ? day : now.getDate();

    if (d > 0) {
      start_time = new Date(y, m - 1, d).getTime();
      end_time = start_time + 86400000 - 1;
    } else {
      // 如果没有指定具体日期，显示最近 24 小时或当前月的第一天
      start_time = new Date(y, m - 1, 1).getTime();
      end_time = new Date(y, m, 0, 23, 59, 59, 999).getTime();
    }

    const hourlyData = await SyncManager.fetchHourlyReport(this.currentStoreId, start_time, end_time);

    if (!hourlyData || hourlyData.length === 0) {
      el.innerHTML = '<div style="height:100px; display:flex; align-items:center; justify-content:center; color:var(--text-muted);">暂无小时数据</div>';
      return;
    }

    const max = Math.max(1, ...hourlyData.map(h => h.amount));
    el.innerHTML = hourlyData.map(h => {
      const height = (h.amount / max) * 100;
      return `
        <div class="chart-bar" style="height:${height}%" title="${h.hour}点: ¥${formatPrice(h.amount)} (${h.count}笔)">
          <div class="chart-bar-label">${h.hour}</div>
        </div>
      `;
    }).join('');
  }

  async updateMainStatsFromBackend() {
    const yearSelect = document.getElementById('filterYear');
    const monthSelect = document.getElementById('filterMonth');
    const daySelect = document.getElementById('filterDay');
    const now = new Date();
    const year = yearSelect ? parseInt(yearSelect.value) : now.getFullYear();
    const month = monthSelect ? parseInt(monthSelect.value) : now.getMonth() + 1;
    const day = daySelect ? parseInt(daySelect.value) : now.getDate();

    // Compute start/end timestamps from filter selections
    let start_time, end_time;
    if (day > 0 && month > 0) {
      start_time = new Date(year, month - 1, day).getTime();
      end_time = start_time + 86400000 - 1;
    } else if (month > 0) {
      start_time = new Date(year, month - 1, 1).getTime();
      end_time = new Date(year, month, 0, 23, 59, 59, 999).getTime();
    } else {
      start_time = new Date(year, 0, 1).getTime();
      end_time = new Date(year, 11, 31, 23, 59, 59, 999).getTime();
    }

    try {
      const data = await SyncManager.fetchReportSummary(this.currentStoreId, start_time, end_time);
      if (data && data.summary) {
        const amountEl = document.getElementById('mainSalesAmount');
        const countEl = document.getElementById('mainSalesCount');
        if (amountEl) amountEl.textContent = formatPrice(data.summary.total_sales);
        if (countEl) countEl.textContent = data.summary.order_count;
      }
    } catch (e) {
      console.warn('fetchReportSummary failed:', e);
    }
  }

  updateMainStats() {
    this.updateMainStatsFromBackend();
  }

  async renderCashierReport() {
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const endOfDay = startOfDay + 86400000 - 1;
    const amountEl = document.getElementById('cashierTodayAmount');
    const countEl = document.getElementById('cashierTodayCount');

    try {
      const data = await SyncManager.fetchReportSummary(this.currentUser?.store_id, startOfDay, endOfDay);
      if (data && data.summary) {
        if (amountEl) amountEl.textContent = formatPrice(data.summary.total_sales);
        if (countEl) countEl.textContent = data.summary.order_count;
        return;
      }
    } catch (e) {
      console.warn('fetchReportSummary failed for cashier report:', e);
    }

    try {
      const orders = await SyncManager.fetchCloudOrders({
        store_id: this.currentUser?.store_id,
        start_time: startOfDay,
        end_time: endOfDay
      });
      const validOrders = (orders || []).filter(order => ['paid', 'refund_requested'].includes(order.status));
      const totalSales = validOrders.reduce((sum, order) => sum + getTxAmount(order), 0);

      if (amountEl) amountEl.textContent = formatPrice(totalSales);
      if (countEl) countEl.textContent = validOrders.length;
      return;
    } catch (e) {
      console.warn('fetchCloudOrders fallback failed for cashier report:', e);
    }

    if (amountEl) amountEl.textContent = '0.00';
    if (countEl) countEl.textContent = '0';
  }

  async renderTeamReport() {
    if (!this.currentUser || !['merchant_admin', 'store_manager'].includes(this.currentUser.role)) {
      return;
    }

    try {
      // 使用新的 /users 接口获取员工
      const storeId = this.effectiveStoreId || this.currentUser.store_id;
      const resp = await SyncManager.request(`/users${storeId ? `?store_id=${storeId}` : ''}`);

      if (resp.code !== 200) {
        console.error('Fetch users failed:', resp);
        if (this.dom.teamReportGrid) {
          this.dom.teamReportGrid.innerHTML = `<div style="grid-column: 1/-1; text-align:center; padding:2rem; color:var(--danger);">加载失败: ${resp.message || '未知错误'}</div>`;
        }
        return;
      }

      const staff = resp.data.filter(u => u.role === 'cashier'); // 报表通常关注收银员
      console.log(`Found ${staff.length} staff members for report`);

      // 统计逻辑使用云端获取
      const allTxs = await SyncManager.fetchCloudTransactions(storeId) || [];
      const now = new Date();
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
      const todayTxs = allTxs.filter(tx => tx.time >= todayStart);

      if (this.dom.teamReportGrid) {
        if (staff.length === 0) {
          this.dom.teamReportGrid.innerHTML = '<div style="grid-column: 1/-1; text-align:center; padding:2rem; color:var(--text-muted);">暂无可见成员绩效</div>';
        } else {
          this.dom.teamReportGrid.innerHTML = staff.map(sub => {
            const subTxs = (todayTxs || []).filter(tx => {
              if (!tx) return false;
              // 统一按用户 ID 匹配（如果 tx 中有该字段）或账号名
              return tx.processed_by === sub.username || tx.processed_by === sub.name;
            });
            const total = subTxs.reduce((sum, tx) => sum + (tx.isRefund ? 0 : (tx.total || tx.amount || 0)), 0);
            const count = subTxs.filter(tx => !tx.isRefund).length;

            return `
              <div class="team-card">
                <div class="team-card-header">
                  <span class="sub-avatar">${sub.name ? sub.name[0] : 'U'}</span>
                  <div class="sub-info">
                    <div class="sub-name">${escapeHtml(sub.name)}</div>
                    <div class="sub-username">@${escapeHtml(sub.username)}</div>
                  </div>
                </div>
                <div class="team-card-stats">
                  <div class="team-stat">
                    <div class="label">营收额</div>
                    <div class="value">¥ ${formatPrice(total)}</div>
                  </div>
                  <div class="team-stat">
                    <div class="label">订单数</div>
                    <div class="value">${count}</div>
                  </div>
                </div>
              </div>
            `;
          }).join('');
        }
      }
    } catch (err) {
      console.error('Failed to render team report:', err);
    }
  }

  renderCategories() {
    const cats = getCategories(this.products);

    if (this.dom.categoriesEl) {
      this.dom.categoriesEl.innerHTML = cats
        .map((c) => `<button type="button" class="cat-btn ${c === this.currentCategory ? 'active' : ''}" data-category="${c}">${c}</button>`)
        .join('');
    }

    if (this.dom.productsPageCategories) {
      this.dom.productsPageCategories.innerHTML = cats
        .map((c) => `<button type="button" class="cat-btn ${c === this.currentCategory ? 'active' : ''}" data-category="${c}">${c}</button>`)
        .join('');
    }
  }

  renderProducts() {
    const list = getFilteredProducts(this.products, this.currentCategory, this.searchKeyword);

    if (this.dom.productsGrid) {
      this.dom.productsGrid.innerHTML = list.map((p) => {
        const hasSKUs = p.skus && p.skus.length > 1; // 超过一个规格才显示为多规格

        if (!hasSKUs) {
          // 单规格显示 (标准)
          const sku = p.skus && p.skus.length === 1 ? p.skus[0] : null;
          const price = sku ? sku.price : (p.price || 0);
          const stock = sku ? sku.stock : (p.stock || 0);
          const isLow = stock < 10;

          return `
              <div class="product-card ${isLow ? 'low-stock' : ''}" data-id="${p.id}">
                ${isLow ? `<div class="stock-warning-tag">库存低: ${stock}</div>` : ''}
                <div class="name">${escapeHtml(p.name)}</div>
                <div class="price">¥ ${formatPrice(price)}</div>
                <div class="stock">库存: ${stock}</div>
              </div>
            `;
        } else {
          // 多规格显示
          const minPrice = Math.min(...p.skus.map(s => s.price));
          const maxPrice = Math.max(...p.skus.map(s => s.price));
          const totalStock = p.skus.reduce((sum, s) => sum + (s.stock || 0), 0);
          const isLow = totalStock < 10;
          const priceStr = minPrice === maxPrice ? `¥ ${formatPrice(minPrice)}` : `¥ ${formatPrice(minPrice)}~${formatPrice(maxPrice)}`;

          return `
              <div class="product-card product-multi ${isLow ? 'low-stock' : ''}" data-id="${p.id}">
                ${isLow ? `<div class="stock-warning-tag">库存低: ${totalStock}</div>` : ''}
                <div class="name">${escapeHtml(p.name)}</div>
                <div class="price">${priceStr}</div>
                <div class="stock">多规格 (${p.skus.length})</div>
              </div>
            `;
        }
      }).join('');
    }
  }

  renderProductsPage() {
    const list = getFilteredProducts(this.products, this.currentCategory, this.searchKeyword);

    if (this.dom.productsPageGrid) {
      this.dom.productsPageGrid.innerHTML = list.map((p) => {
        // 优先读取单 SKU 的库存，与收银台保持一致
        const sku = p.skus && p.skus.length === 1 ? p.skus[0] : null;
        const stock = sku ? (sku.stock ?? 0) : (p.stock !== undefined ? p.stock : 9999);
        const lowStockClass = stock < 10 ? 'low-stock' : '';
        return `
            <div class="product-card" data-id="${p.id}">
              <div class="name">${escapeHtml(p.name)}</div>
              <div class="price">¥ ${formatPrice(p.price)}</div>
              <div class="stock ${lowStockClass}">库存: ${stock}</div>
              <div style="margin-top:8px;display:flex;gap:4px;">
                <button type="button" class="edit-product-btn" data-id="${p.id}" style="flex:1;padding:4px 8px;background:#4a90e2;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:12px;">编辑</button>
                <button type="button" class="delete-product-btn" data-id="${p.id}" style="flex:1;padding:4px 8px;background:#e74c3c;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:12px;">删除</button>
              </div>
            </div>
          `}).join('');
    }
  }

  async renderHistory(isLoadMore = false) {
    if (!isLoadMore) {
      this.historyPage = 1;
      const storeId = this.currentStoreId || '';
      const filter = this.dom.historyDateFilter?.value || 'all';
      const keyword = this.dom.historySearch?.value.trim() || '';
      
      let startTime = null;
      if (filter === 'today') {
        const d = new Date(); d.setHours(0,0,0,0);
        startTime = d.getTime();
      } else if (filter === 'week') {
        const d = new Date(); d.setDate(d.getDate() - 7); d.setHours(0,0,0,0);
        startTime = d.getTime();
      } else if (filter === 'month') {
        const d = new Date(); d.setDate(1); d.setHours(0,0,0,0);
        startTime = d.getTime();
      }

      try {
        // Phase 3: Using /orders instead of /transactions
        this.transactions = await SyncManager.fetchCloudOrders({ 
            store_id: storeId, 
            start_time: startTime 
        }) || [];
      } catch (err) {
        console.error('Failed to fetch history:', err);
      }
      
      // Client-side search keyword still applied as fallback or extra filter
      this.filteredHistory = getTransactionHistory(this.transactions, 'all', keyword);
    }

    if (!this.dom.historyList) return;

    if (this.filteredHistory.length === 0) {
      this.dom.historyList.innerHTML = '<div class="history-empty">暂无交易记录</div>';
      if (this.dom.historyPagination) this.dom.historyPagination.style.display = 'none';
      return;
    }

    const start = (this.historyPage - 1) * this.historyPageSize;
    const end = start + this.historyPageSize;
    const pageData = this.filteredHistory.slice(start, end);

    const html = pageData.map(tx => {
      const date = new Date(tx.time);
      const dateStr = date.toLocaleDateString('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      });
      const timeStr = date.toLocaleTimeString('zh-CN', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      });

      const itemCount = tx.items ? tx.items.reduce((sum, item) => sum + item.qty, 0) : 0;

        return `
            <div class="history-item" data-id="${tx.id}">
              <div class="history-header">
                <div class="history-header-left">
                  <span class="history-id">${tx.order_no || tx.id}</span>
                  <span class="history-time">${dateStr} ${timeStr}</span>
                </div>
                <div class="history-header-right" style="display:flex; align-items:center;">
                  <span class="history-total">¥${formatPrice(tx.total || tx.amount)}</span>
                  ${ tx.status === 'refunded' ? '<span class="status-refund">已退款</span>' : tx.status === 'partially_refunded' ? '<span class="status-refund" style="background:#e67e22;">部分退款</span>' : tx.status === 'refund_requested' ? '<span style="color:var(--warning);font-size:12px;">退款申请中</span>' : '' }
                  <span class="history-count">${itemCount}件商品</span>
                  <span class="history-toggle">▼</span>
                </div>
              </div>
              <div class="history-details">
                ${tx.items && tx.items.length > 0 ? `
                  <table class="history-products-table">
                    <thead>
                      <tr>
                        <th>商品名称</th>
                        <th>单价</th>
                        <th>数量</th>
                        <th>小计</th>
                      </tr>
                    </thead>
                    <tbody>
                      ${tx.items.map(item => `
                        <tr>
                          <td>${escapeHtml(item.name)}</td>
                          <td>¥${formatPrice(item.price)}</td>
                          <td>${item.qty}</td>
                          <td>¥${formatPrice(item.subtotal)}</td>
                        </tr>
                      `).join('')}
                    </tbody>
                  </table>
                  <div class="history-summary">
                    <div class="history-summary-item">
                      <span class="history-summary-label">总计：</span>
                      <span class="history-summary-value history-summary-total">¥${formatPrice(tx.total || tx.amount)}</span>
                    </div>
                    <div style="display:flex;gap:8px;flex-wrap:wrap;">${ ['paid', 'partially_refunded'].includes(tx.status) ? `<button class="btn-refund" data-txid="${tx.id}" style="flex:1;padding:6px 12px;">申请退款</button>` : '' }<button class="btn-print-receipt" data-txid="${tx.id}" style="flex:1;padding:6px 12px;background:transparent;border:1px solid var(--border);border-radius:4px;cursor:pointer;font-size:13px;">🖨️ 打印小票</button></div>
                  </div>
                ` : '<p style="padding:1rem;color:var(--text-muted);">无详细商品信息（旧数据）</p>'}
              </div>
            </div>
          `;
    }).join('');

    if (isLoadMore) {
      this.dom.historyList.insertAdjacentHTML('beforeend', html);
    } else {
      this.dom.historyList.innerHTML = html;
    }

    // 更新分页显示
    if (this.dom.historyPagination) {
      this.dom.historyPagination.style.display =
        this.filteredHistory.length > this.historyPage * this.historyPageSize ? 'block' : 'none';
    }

    // 添加点击事件监听器
    this.dom.historyList.querySelectorAll('.history-item:not(.has-listener)').forEach(item => {
      const header = item.querySelector('.history-header');
      header.addEventListener('click', () => {
        item.classList.toggle('expanded');
      });

      const refundBtn = item.querySelector('.btn-refund');
      refundBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        const txId = item.dataset.id;
        if (confirm(`确定要退款订单 ${txId} 吗？`)) {
          this.refundTransaction(txId);
        }
      });

      const printBtn = item.querySelector('.btn-print-receipt');
      printBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        const txId = printBtn.dataset.txid;
        const total = printBtn.dataset.total;
        const tx = this.filteredHistory.find(t => t.id === txId);
        if (tx) this.printReceipt(tx);
      });

      item.classList.add('has-listener');
    });
  }


  async renderRefunds() {
    if (!this.dom.refundsList) return;

    const status = this.dom.refundsStatusFilter?.value || '';
    const storeId = this.dom.refundsStoreFilter?.value || (this.currentUser?.role === 'store_manager' ? this.currentUser.store_id : '');

    try {
      this.dom.refundsList.innerHTML = '<div style="padding: 20px; text-align: center;">加载中...</div>';
      const refunds = await SyncManager.fetchRefunds(storeId, status);
      
      if (!refunds || refunds.length === 0) {
        this.dom.refundsList.innerHTML = '<div style="padding: 20px; text-align: center; color: var(--text-muted);">暂无退款申请记录</div>';
        return;
      }

      const html = refunds.map(r => {
        const dateStr = new Date(r.created_at).toLocaleString('zh-CN');
        const statusMap = {
          'requested': '<span style="color:var(--warning);">待审批</span>',
          'approved': '<span style="color:var(--accent);">已通过</span>',
          'rejected': '<span style="color:var(--danger);">已拒绝</span>',
          'refunded': '<span style="color:var(--text-muted);">已退款</span>'
        };
        const statusText = statusMap[r.status] || r.status;
        
        return `
          <div class="history-item" data-id="${r.id}">
            <div class="history-header">
              <div class="history-header-left">
                <span class="history-id">订单号: ${r.order_id}</span>
                <span class="history-time">${dateStr}</span>
              </div>
              <div class="history-header-right">
                <span class="history-total">退款 ¥${formatPrice(r.amount)}</span>
                <span style="font-size:12px;color:var(--text-muted);margin-right:8px;">(单总额: ¥${formatPrice(r.order_total)})</span>
                ${statusText}
                <span style="font-size:12px;color:var(--text-muted);margin-left:8px;">申请人: ${escapeHtml(r.requester_name || r.requested_by || '未知')}</span>
              </div>
            </div>
            <div class="history-details" style="display:block; padding:10px 15px; background:var(--bg-light);">
              <p style="margin:0 0 10px 0;"><strong>退款原因：</strong> ${escapeHtml(r.reason || '无')}</p>
              ${r.status === 'requested' ? `
                <div style="margin-top:10px; display:flex; gap:10px; justify-content:flex-end;">
                  <button class="btn-approve-refund" data-id="${r.id}" style="padding:6px 16px; background:var(--accent); color:#fff; border:none; border-radius:4px; cursor:pointer;">同意退款</button>
                  <button class="btn-reject-refund" data-id="${r.id}" style="padding:6px 16px; background:var(--danger); color:#fff; border:none; border-radius:4px; cursor:pointer;">拒绝退款</button>
                </div>
              ` : `
                ${r.approved_by ? `<p style="margin:0; font-size:12px; color:var(--text-muted);">处理人: ${escapeHtml(r.approved_by)} | 处理时间: ${new Date(r.updated_at).toLocaleString('zh-CN')}</p>` : ''}
              `}
            </div>
          </div>
        `;
      }).join('');

      this.dom.refundsList.innerHTML = html;

      // Bind events for approve/reject
      this.dom.refundsList.querySelectorAll('.btn-approve-refund').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          if (!confirm('确定要同意此退款吗？这将退还金额并补回库存。')) return;
          const id = e.target.dataset.id;
          btn.disabled = true;
          try {
            const res = await SyncManager.approveRefund(id);
            if (res.code === 200) {
              alert('退款已同意并处理完成');
              this.renderRefunds();
            } else {
              alert('处理失败: ' + res.message);
              this.renderRefunds();
            }
          } catch(err) {
            alert('网络异常: ' + err.message);
            this.renderRefunds();
          }
        });
      });

      this.dom.refundsList.querySelectorAll('.btn-reject-refund').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          if (!confirm('确定要拒绝此退款申请吗？')) return;
          const id = e.target.dataset.id;
          btn.disabled = true;
          try {
            const res = await SyncManager.rejectRefund(id);
            if (res.code === 200) {
              alert('退款已拒绝');
              this.renderRefunds();
            } else {
              alert('处理失败: ' + res.message);
              this.renderRefunds();
            }
          } catch(err) {
            alert('网络异常: ' + err.message);
            this.renderRefunds();
          }
        });
      });

    } catch (err) {
      console.error('Failed to fetch refunds:', err);
      this.dom.refundsList.innerHTML = '<div style="padding: 20px; text-align: center; color: var(--danger);">加载失败，请检查网络或稍后重试</div>';
    }
  }

  updateCartUI() {
    const totalItems = this.cart.reduce((sum, c) => sum + c.qty, 0);
    const totals = computeCartTotal(this.cart, [], TAX_RATE);
    const total = totals.total;

    const totalSummary = document.getElementById('totalSummary');
    if (totalSummary) {
      totalSummary.textContent = `共${totalItems}件 总计¥${formatPrice(total)}`;
    }

    if (this.cart.length === 0) {
      this.dom.cartList.innerHTML = '<tr class="cart-empty-row"><td colspan="4" id="cartEmpty">暂无商品，请搜索或点击临时商品添加</td></tr>';
      return;
    }

    this.dom.cartList.innerHTML = this.cart.map((c) => `
          <tr class="cart-item-row" data-id="${c.skuId}">
            <td>
              ${escapeHtml(c.product.name)}
              ${c.sku && c.sku.specName !== '标准' ? `<small style="display:block;color:var(--text-muted)">[${escapeHtml(c.sku.specName)}]</small>` : ''}
            </td>
            <td>¥ ${formatPrice(c.sku ? c.sku.price : c.product.price)}</td>
            <td class="cart-qty-cell">
              <button type="button" class="qty-btn" aria-label="减少">−</button>
              <input type="number" class="qty-input" value="${c.qty}" aria-label="数量" />
              <button type="button" class="qty-btn" aria-label="增加">+</button>
            </td>
            <td class="price-cell">¥ ${formatPrice((c.sku ? c.sku.price : c.product.price) * c.qty)}</td>
          </tr>
        `).join('');

    this.dom.cartList.querySelectorAll('.cart-item-row').forEach((row) => {
      const id = row.dataset.id;
      const [minusBtn, plusBtn] = row.querySelectorAll('.qty-btn');
      const qtyInput = row.querySelector('.qty-input');
      const item = this.cart.find((c) => c.product.id === id);

      minusBtn.addEventListener('click', () => this.setCartQty(id, item.qty - 1));
      plusBtn.addEventListener('click', () => this.setCartQty(id, item.qty + 1));

      qtyInput.addEventListener('change', (e) => {
        const newQty = parseInt(e.target.value);
        if (!isNaN(newQty) && newQty >= 0) {
          this.setCartQty(id, newQty);
        } else {
          e.target.value = item.qty; // 恢复旧值
        }
      });

      // 防止输入框点击触发其他事件（如有）
      qtyInput.addEventListener('click', (e) => e.stopPropagation());
    });
  }

  addToCart(product) {
    if (!product) return;

    const skus = product.skus || [];
    // 如果有多规格，弹出选择框
    if (skus.length > 1) {
      this.openSkuSelectionModal(product);
      return;
    }

    // 单规格直接加入
    const sku = skus.length === 1 ? skus[0] : {
      id: product.id,
      specName: '标准',
      price: product.price,
      stock: product.stock,
      barcode: product.barcode
    };

    this.addSkuToCart(product, sku);
  }

  addSkuToCart(product, sku) {
    const existing = this.cart.find((item) => item.skuId === sku.id);
    const currentQty = existing ? existing.qty : 0;
    const stock = sku.stock !== undefined ? sku.stock : 9999;

    if (currentQty + 1 > stock) {
      alert(`规格 [${sku.specName}] 库存不足！当前库存仅有 ${stock} 件`);
      return;
    }

    if (existing) {
      existing.qty++;
    } else {
      this.cart.push({
        product,
        sku,
        skuId: sku.id,
        qty: 1
      });
    }
    this.updateCartUI();
  }

  openSkuSelectionModal(product) {
    const titleEl = document.getElementById('skuModalProductName');
    const listEl = document.getElementById('skuList');
    if (titleEl) titleEl.textContent = product.name;
    if (listEl) {
      listEl.innerHTML = (product.skus || []).map(sku => `
        <div class="sku-item" data-sku-id="${sku.id}">
          <span class="sku-name">${escapeHtml(sku.specName)}</span>
          <span class="sku-price">¥ ${formatPrice(sku.price)}</span>
        </div>
      `).join('');

      listEl.querySelectorAll('.sku-item').forEach(el => {
        el.onclick = () => {
          const skuId = el.dataset.skuId;
          const sku = product.skus.find(s => s.id === skuId);
          this.addSkuToCart(product, sku);
          this.dom.skuModal.classList.remove('show');
        };
      });
    }
    this.dom.skuModal.classList.add('show');
  }

  setCartQty(skuId, qty) {
    const item = this.cart.find((c) => c.skuId === skuId);
    if (!item) return;

    const stock = item.sku ? (item.sku.stock !== undefined ? item.sku.stock : 9999) : 9999;

    if (qty > stock) {
      alert(`库存不足！当前库存仅有 ${stock} 件`);
      return;
    }

    if (qty <= 0) {
      this.cart = this.cart.filter((c) => c.skuId !== skuId);
    } else {
      item.qty = qty;
    }
    this.updateCartUI();
  }

  clearCart() {
    this.cart = [];
    this.updateCartUI();
  }

  openSettleModal() {
    if (this.cart.length === 0) return;
    
    if (!this.currentStoreId) {
      alert('【未选择门店】\n管理员账号需先在左侧菜单栏切换到具体门店，才能进行结账。');
      return;
    }

    const totals = computeCartTotal(this.cart, [], TAX_RATE);
    const total = totals.total;

    const lines = this.cart.map((c) => `
          <div class="receipt-line">
            <span>
              ${escapeHtml(c.product.name)}
              ${c.sku && c.sku.specName !== '标准' ? `<small>[${escapeHtml(c.sku.specName)}]</small>` : ''}
              × ${c.qty}
            </span>
            <span>¥ ${formatPrice((c.sku ? c.sku.price : c.product.price) * c.qty)}</span>
          </div>
        `).join('');

    this.dom.receiptPreview.innerHTML = lines + `<div class="receipt-total">合计：¥ ${formatPrice(total)}</div>`;
    this.dom.paymentAmountEl.textContent = '¥ ' + formatPrice(total);

    // 重置支付状态
    this.currentOrderPayments = [];
    this.renderPaymentRecordsUI(total);
    this.dom.mixPaymentAmount.value = formatPrice(total);
    this.dom.settleModal.classList.add('show');
  }

  renderPaymentRecordsUI(totalReceivable) {
    const list = this.dom.paymentRecordList;
    const paid = this.currentOrderPayments.reduce((sum, p) => sum + p.amount, 0);
    const remaining = Math.max(0, totalReceivable - paid);

    this.dom.paidAmountEl.textContent = '¥ ' + formatPrice(paid);
    this.dom.remainingAmountEl.textContent = '¥ ' + formatPrice(remaining);

    if (this.currentOrderPayments.length === 0) {
      list.innerHTML = '<div class="empty-tip" style="padding: 10px; font-size: 0.85rem; color: #999; text-align: center;">尚未录入支付明细</div>';
    } else {
      list.innerHTML = this.currentOrderPayments.map((p, index) => `
        <div class="payment-record-item" style="display:flex; justify-content:space-between; align-items:center; padding:8px 0; border-bottom:1px solid #f0f0f0;">
          <span>${p.method === 'scan' ? '📱 扫码' : '💵 现金'}：¥${formatPrice(p.amount)}</span>
          <button class="btn-remove-payment" data-index="${index}" style="background:none; border:none; color:var(--danger); cursor:pointer;">移除</button>
        </div>
      `).join('');

      list.querySelectorAll('.btn-remove-payment').forEach(btn => {
        btn.onclick = () => {
          this.currentOrderPayments.splice(btn.dataset.index, 1);
          this.renderPaymentRecordsUI(totalReceivable);
        };
      });
    }

    this.dom.btnConfirmSettle.disabled = (paid < totalReceivable - 0.01);
    this.dom.mixPaymentAmount.value = formatPrice(remaining > 0 ? remaining : 0);
  }

  handleAddPaymentLine() {
    const method = this.dom.mixPaymentMethod.value;
    const amount = parseFloat(this.dom.mixPaymentAmount.value);
    const totals = computeCartTotal(this.cart, [], TAX_RATE);
    
    if (isNaN(amount) || amount <= 0) {
      alert('请输入有效支付金额');
      return;
    }

    this.currentOrderPayments.push({ method, amount });
    this.renderPaymentRecordsUI(totals.total);
  }

  closeSettleModal() {
    this.dom.settleModal.classList.remove('show');
  }

  async fetchOrderById(orderId) {
    const orders = await SyncManager.fetchCloudOrders({ order_id: orderId });
    return (orders || []).find(order => order.id === orderId) || null;
  }

  async waitForPaidOrder(orderId, options = {}) {
    const { attempts = 8, intervalMs = 1000 } = options;

    for (let i = 0; i < attempts; i++) {
      const order = await this.fetchOrderById(orderId);
      if (order && order.status === 'paid' && order.payment_status === 'paid') {
        return order;
      }

      if (i < attempts - 1) {
        await new Promise(resolve => setTimeout(resolve, intervalMs));
      }
    }

    return null;
  }

  async confirmSettle() {
    const totals = computeCartTotal(this.cart, [], TAX_RATE);
    const total = totals.total;
    const totalItems = this.cart.reduce((sum, c) => sum + c.qty, 0);

    if (this.currentOrderPayments.length === 0) {
      alert('请先添加支付明细');
      return;
    }

    const totalPaid = this.currentOrderPayments.reduce((sum, p) => sum + p.amount, 0);
    if (totalPaid < total - 0.01) {
      alert('支付总额不足，请继续添加支付方式');
      return;
    }

    const btn = this.dom.btnConfirmSettle;
    if (btn) { btn.disabled = true; btn.textContent = '创建订单...'; }

    let orderId = null;
    try {
      const client_tx_id = (this.currentUser?.id || 'guest') + '_' + Date.now() + '_' + Math.floor(Math.random() * 9999);
      const orderPayload = {
        client_tx_id,
        store_id: this.currentStoreId,
        total,
        amount: total,
        payment_method: this.currentOrderPayments.length > 1 ? 'mixed' : this.currentOrderPayments[0].method,
        items: this.cart.map(c => ({
          product_id: c.product.id,
          sku_id: c.sku && c.sku.id !== c.product.id ? c.sku.id : null,
          name: c.product.name + (c.sku && c.sku.specName !== '标准' ? ' [' + c.sku.specName + ']' : ''),
          price: c.sku ? c.sku.price : c.product.price,
          qty: c.qty
        }))
      };

      const result = await SyncManager.createOrder(orderPayload);
      if (result && result.code === 200) {
        orderId = result.data.order_id;
        btn.textContent = '正在处理支付...';

        // 顺序处理多笔支付
        for (const p of this.currentOrderPayments) {
          const payResp = await SyncManager.createPayment(orderId, p.amount, p.method);
          if (payResp.code !== 200) {
             throw new Error(`支付发起失败 (${p.method}): ${payResp.message}`);
          }
        }

        btn.textContent = '确认支付结果...';
        const paidOrder = await this.waitForPaidOrder(orderId, { attempts: 10, intervalMs: 800 });

        if (!paidOrder) {
          alert('支付确认超时，请稍后在交易历史中查看订单状态。');
          this.closeSettleModal();
          return;
        }

        this.finalizeOrder(paidOrder, totalItems, total, totalPaid - total);
      } else if (result && result.code === 409) {
        this.closeSettleModal();
        this.clearCart();
        showToast('toast');
      } else {
        alert('结账失败：' + ((result && result.message) || '请稍后重试'));
      }
    } catch (err) {
      console.error('confirmSettle error:', err);
      // 支付失败，尝试取消订单以恢复库存
      if (orderId) {
        try {
          await SyncManager.request(`/orders/${orderId}/cancel`, { method: 'POST' });
          console.log('Order cancelled, inventory restored:', orderId);
        } catch (rollbackErr) {
          console.error('Failed to rollback order:', rollbackErr);
        }
      }
      alert('操作失败：' + err.message);
    } finally {
      if (btn) { 
        const paid = this.currentOrderPayments.reduce((sum, p) => sum + p.amount, 0);
        btn.disabled = paid < total - 0.01; 
        btn.textContent = '确认并完成订单'; 
      }
    }
  }

  finalizeOrder(order, totalItems, total, change) {
    this.lastOrder = { qty: totalItems, amount: total };
    this.closeSettleModal();
    this.clearCart();
    this.initialCloudPull().then(() => {
      this.updateStatsUI();
      this.updateLastOrderUI();
      this.renderProducts();
      this.checkStockLevels();
    });
    
    // 自动打印小票 (Phase 3: 只有支付成功才打印)
    if (order) {
      this.printReceipt(order);
    }

    if (change > 0) {
      setTimeout(() => alert('结账成功！\n请找零：¥ ' + formatPrice(change)), 100);
    } else {
      showToast('toast');
    }
  }

  async handleAddProduct(e) {
    e.preventDefault();

    const name = document.getElementById('productName').value.trim();
    const price = parseFloat(document.getElementById('productPrice').value);
    const stock = parseInt(document.getElementById('productStock').value) || 0;
    const barcode = document.getElementById('productBarcode')?.value.trim() || '';
    const catVal = this.dom.productCategorySelect.value;

    let category = catVal;
    if (catVal === '_new_') {
      const newCat = this.dom.productCategoryNew.value.trim();
      if (!newCat) {
        alert('请输入新分类名称');
        return;
      }
      category = newCat;
    }

    if (!name) {
      alert('请输入商品名称');
      return;
    }

    if (isNaN(price) || price < 0) {
      alert('请输入有效价格');
      return;
    }

    const inventoryStoreId = this.currentStoreId || this.currentUser?.store_id || null;
    if (!inventoryStoreId) {
      alert('请先选择门店后再维护商品和库存');
      return;
    }

    let inventoryAdjustment = null;

    if (this.editingProductId) {
      const p = this.products.find((x) => x.id === this.editingProductId);
      if (p) {
        const oldStock = p.stock !== undefined ? parseInt(p.stock) || 0 : 0;
        p.name = name;
        p.price = price;
        p.stock = stock;
        p.category = category;
        p.barcode = barcode;
        // 同步更新 SKU (如果是单规格)
        if (p.skus && p.skus.length === 1) {
          p.skus[0].price = price;
          p.skus[0].stock = stock;
          p.skus[0].barcode = barcode;
        }

        const delta = stock - oldStock;
        if (delta !== 0) {
          inventoryAdjustment = {
            product_id: p.id,
            qty: delta,
            reason: 'product_form_edit'
          };
        }
      }
      SyncManager.logAudit('EDIT_PRODUCT', {
        id: this.editingProductId,
        name,
        price,
        stock,
        category,
        user: this.currentUser ? this.currentUser.name : '未知'
      });
      this.editingProductId = null;
      showToast('toastAddProduct');
    } else {
      // 检查是否已存在同名或同条码的商品
      const existingProduct = this.products.find(p => p.name === name || (barcode && p.barcode === barcode));

      if (existingProduct) {
        // 合并库存并更新信息
        const oldStock = existingProduct.stock !== undefined ? parseInt(existingProduct.stock) : 0;
        existingProduct.stock = oldStock + stock;
        existingProduct.price = price; // 更新为最新价格
        existingProduct.category = category;
        if (barcode) existingProduct.barcode = barcode;

        // 同步更新 SKU
        if (existingProduct.skus && existingProduct.skus.length === 1) {
          existingProduct.skus[0].price = price;
          existingProduct.skus[0].stock = existingProduct.stock;
          existingProduct.skus[0].barcode = existingProduct.barcode;
        }

        SyncManager.logAudit('UPDATE_STOCK', {
          name,
          added_stock: stock,
          total_stock: existingProduct.stock,
          user: this.currentUser ? this.currentUser.name : '未知'
        });

        if (stock !== 0) {
          inventoryAdjustment = {
            product_id: existingProduct.id,
            qty: stock,
            reason: 'product_form_add_stock'
          };
        }

        // 这里可以改一下提示，但复用"商品已添加"也合理（添加了库存）
        showToast('toastAddProduct');
      } else {
        const id = 'P' + Date.now();
        const newProduct = {
          id,
          name,
          price,
          stock,
          category,
          barcode,
          skus: [{
            id: id + '_s1',
            specName: '标准',
            price,
            stock,
            barcode
          }]
        };
        this.products.push(newProduct);
        SyncManager.logAudit('ADD_PRODUCT', {
          name,
          price,
          stock,
          user: this.currentUser ? this.currentUser.name : '未知'
        });
        showToast('toastAddProduct');
      }
    }

    saveProducts(this.products);

    const syncResult = await SyncManager.syncProducts(this.products);
    if (syncResult.code !== 200) {
      alert('商品同步失败：' + (syncResult.message || '请稍后重试'));
      return;
    }

    if (inventoryAdjustment) {
      const adjustResult = await SyncManager.adjustInventory({
        store_id: inventoryStoreId,
        product_id: inventoryAdjustment.product_id,
        qty: inventoryAdjustment.qty,
        reason: inventoryAdjustment.reason
      });

      if (adjustResult.code !== 200) {
        alert('库存调整失败：' + (adjustResult.message || '请稍后重试'));
        return;
      }
    }

    this.dom.addProductForm.reset();
    this.dom.productCategoryNew.style.display = 'none';
    await this.initialCloudPull();
    this.renderProducts();
    this.renderProductsPage();
    this.checkStockLevels(); // 添加/修改后检查库存

    // 保持在商品管理页面，如果是在那里编辑的话
    if (document.querySelector('.nav-item[data-view="products"]').classList.contains('active')) {
      this.renderProductsPage();
    } else {
      this.switchView('pos'); // 否则返回收银台
    }
  }

  editProduct(productId) {
    const product = this.products.find((p) => p.id === productId);
    if (!product) return;

    this.editingProductId = productId;

    document.getElementById('productName').value = product.name;
    document.getElementById('productPrice').value = product.price;
    document.getElementById('productStock').value = product.stock !== undefined ? product.stock : 9999;
    document.getElementById('productBarcode').value = product.barcode || '';

    const cats = Array.from(this.dom.productCategorySelect.options).map(o => o.value);
    if (cats.includes(product.category)) {
      this.dom.productCategorySelect.value = product.category;
      this.dom.productCategoryNew.style.display = 'none';
    } else {
      this.dom.productCategorySelect.value = '_new_';
      this.dom.productCategoryNew.style.display = 'block';
      this.dom.productCategoryNew.value = product.category;
    }

    this.switchView('addProduct');

    const submitBtn = this.dom.addProductForm.querySelector('button[type="submit"]');
    if (submitBtn) submitBtn.textContent = '保存修改';
  }

  deleteProduct(productId) {
    const product = this.products.find(p => p.id === productId);
    if (!product) return;

    if (!confirm(`确定要删除商品"${product.name}"吗？`)) return;

    SyncManager.logAudit('DELETE_PRODUCT', {
      id: productId,
      name: product.name,
      user: this.currentUser ? this.currentUser.name : '未知'
    });

    this.products = this.products.filter(p => p.id !== productId);
    saveProducts(this.products);
    
    // 同步到后端
    SyncManager.deleteProduct(productId).then(res => {
      if (res.code !== 200) {
        console.warn('Backend product deletion failed:', res.message);
      }
    });

    this.checkStockLevels(); // 删除后检查库存
    this.updateCategorySelect();
    this.renderCategories();
    this.renderProducts();
    this.renderProductsPage();

    this.cart = this.cart.filter(c => c.product.id !== productId);
    this.updateCartUI();
  }

  _switchViewInternal(viewName) {
    this.currentView = viewName;

    // Update Nav
    document.querySelectorAll('.nav-item').forEach(el => {
      el.classList.toggle('active', el.dataset.view === viewName);
    });

    // Update Sections
    document.querySelectorAll('section').forEach(el => el.classList.remove('active'));

    const target = document.getElementById(viewName + 'Section');
    if (target) {
      target.classList.add('active');
    }

    // Specific Logic
    if (viewName === 'products') this.renderProductsPage();
    else if (viewName === 'history') this.renderHistory();
    else if (viewName === 'refunds') this.renderRefunds();
    else if (viewName === 'settings') this.loadReceiptConfig();
    else if (viewName === 'cashierReport') this.renderCashierReport();
    else if (viewName === 'teamReport') this.renderTeamReport();
    else if (viewName === 'report') {
      // this.transactions 将在 renderReport 中被刷新
      this.updateMainStats();
      this.renderSalesChart();
      this.renderHourlyChart();
    }
  }

  async exportBackupJSON() {
    const data = {
      products: this.products,
      transactions: await SyncManager.fetchCloudTransactions(this.currentStoreId) || []
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `pos_backup_${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    alert('备份文件已开始下载！');
  }

  async exportTransactionsCSV() {
    const txs = await SyncManager.fetchCloudTransactions(this.currentStoreId) || [];
    if (txs.length === 0) {
      alert('暂无交易记录');
      return;
    }

    // CSV Header
    let csvContent = '\uFEFF'; // BOM for Excel
    csvContent += "订单号,时间,总金额,支付方式,商品详情\n";

    txs.forEach(tx => {
      const time = new Date(tx.time).toLocaleString().replace(',', ' ');
      const items = tx.items ? tx.items.map(i => `${i.name}x${i.qty}`).join('; ') : '';
      let payment = '默认';
      if (tx.payment) {
        payment = tx.payment.method === 'scan' ? '扫码' : '现金';
      }
      csvContent += `"${tx.id}","${time}",${tx.total},"${payment}","${items}"\n`;
    });

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `pos_report_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  bindEvents() {
    document.getElementById('btnExportBackup')?.addEventListener('click', () => this.exportBackupJSON());
    document.getElementById('btnExportCSV')?.addEventListener('click', () => this.exportTransactionsCSV());

    // 小票配置
    document.getElementById('btnSaveReceiptConfig')?.addEventListener('click', () => this.saveReceiptConfig());
    document.getElementById('btnPreviewReceipt')?.addEventListener('click', () => {
      // Preview with a sample transaction
      this.printReceipt({
        id: 'SAMPLE-001',
        order_no: 'SAMPLE-001',
        time: Date.now(),
        total: 18.50,
        amount: 18.50,
        items: [
          { name: '可乐 330ml', price: 3.50, qty: 2 },
          { name: '面包', price: 6.00, qty: 1 },
          { name: '矿泉水', price: 2.50, qty: 2 }
        ],
        payments: [{ method: '现金', amount: 18.50 }],
        cashier_id: '管理员'
      });
    });

    // 门店切换事件
    document.getElementById('storeSwitcher')?.addEventListener('change', (e) => {
      this.switchStore(e.target.value);
    });

    // 登录与注册切换
    document.getElementById('btnShowRegister')?.addEventListener('click', (e) => {
      e.preventDefault();
      document.getElementById('loginForm').style.display = 'none';
      document.getElementById('registerForm').style.display = 'block';
      document.getElementById('btnShowRegister').style.display = 'none';
      document.getElementById('btnShowLogin').style.display = 'block';
      document.getElementById('loginError').textContent = '';
    });

    document.getElementById('btnShowLogin')?.addEventListener('click', (e) => {
      e.preventDefault();
      document.getElementById('loginForm').style.display = 'block';
      document.getElementById('registerForm').style.display = 'none';
      document.getElementById('btnShowRegister').style.display = 'block';
      document.getElementById('btnShowLogin').style.display = 'none';
      document.getElementById('loginError').textContent = '';
    });

    document.getElementById('loginForm')?.addEventListener('submit', (e) => this.login(e));
    document.getElementById('registerForm')?.addEventListener('submit', (e) => this.handlePublicRegister(e));
    this.dom.initForm?.addEventListener('submit', (e) => this.handleInitSetup(e));

    document.querySelectorAll('.nav-item[data-view]').forEach((el) => {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        this._switchViewInternal(el.dataset.view);
      });
    });

    this.dom.productCategorySelect?.addEventListener('change', () => {
      this.dom.productCategoryNew.classList.toggle(
        'input-new-cat--hidden',
        this.dom.productCategorySelect.value !== '_new_'
      );
    });

    this.dom.addProductForm?.addEventListener('submit', (e) => this.handleAddProduct(e));
    this.dom.addProductForm?.addEventListener('reset', () => {
      this.dom.productCategoryNew.classList.add('input-new-cat--hidden');
      this.editingProductId = null;
      const submitBtn = this.dom.addProductForm.querySelector('button[type="submit"]');
      if (submitBtn) submitBtn.textContent = '添加商品';
    });

    // 员工管理
    this.dom.btnAddSubordinate?.addEventListener('click', () => {
      this.dom.subordinateModal.style.display = 'flex';
    });
    this.dom.btnCancelSub?.addEventListener('click', () => {
      this.dom.subordinateModal.style.display = 'none';
      this.dom.subordinateForm.reset();
    });
    this.dom.subordinateForm?.addEventListener('submit', (e) => {
      e.preventDefault();
      this.handleSubordinateSubmit();
    });

    // 库存调整模态框事件
    this.dom.btnInventoryAdjust?.addEventListener('click', () => this.openInventoryAdjustModal());
    this.dom.btnCancelAdjust?.addEventListener('click', () => this.dom.inventoryAdjustModal?.classList.remove('show'));
    this.dom.inventoryAdjustForm?.addEventListener('submit', (e) => { e.preventDefault(); this.handleInventoryAdjust(); });
    document.getElementById('adjustProductSearch')?.addEventListener('input', (e) => this.onAdjustProductSearch(e.target.value));

    this.dom.productsGrid?.addEventListener('click', (e) => {
      const card = e.target.closest('.product-card');
      if (!card) return;
      const product = this.products.find((p) => p.id === card.dataset.id);
      if (product) this.addToCart(product);
    });

    this.dom.productsPageGrid?.addEventListener('click', (e) => {
      const editBtn = e.target.closest('.edit-product-btn');
      if (editBtn) {
        this.editProduct(editBtn.dataset.id);
        return;
      }

      const deleteBtn = e.target.closest('.delete-product-btn');
      if (deleteBtn) {
        this.deleteProduct(deleteBtn.dataset.id);
        return;
      }

      const card = e.target.closest('.product-card');
      if (!card) return;
      const product = this.products.find((p) => p.id === card.dataset.id);
      if (product) this.addToCart(product);
    });

    const handleCatClick = (e) => {
      const btn = e.target.closest('.cat-btn');
      if (!btn) return;
      this.currentCategory = btn.dataset.category;
      this.renderCategories();
      this.renderProducts();
      this.renderProductsPage();
    };
    this.dom.categoriesEl?.addEventListener('click', handleCatClick);
    this.dom.productsPageCategories?.addEventListener('click', handleCatClick);

    const debouncedSearch = debounce((keyword) => {
      this.searchKeyword = keyword;
      this.renderProducts();
      this.renderProductsPage();
    }, SEARCH_DEBOUNCE_MS);

    this.dom.searchInput?.addEventListener('input', (e) => {
      debouncedSearch(e.target.value.trim());
    });

    this.dom.productsSearch?.addEventListener('input', (e) => {
      debouncedSearch(e.target.value.trim());
    });

    // 交易历史事件
    const debouncedHistorySearch = debounce(() => {
      this.renderHistory();
    }, SEARCH_DEBOUNCE_MS);

    this.dom.historyDateFilter?.addEventListener('change', () => this.renderHistory());
    this.dom.btnLoadMoreHistory?.addEventListener('click', () => {
      this.historyPage++;
      this.renderHistory(true);
    });

    this.dom.refundsStatusFilter?.addEventListener('change', () => this.renderRefunds());
    this.dom.refundsStoreFilter?.addEventListener('change', () => this.renderRefunds());

    document.getElementById('btnAddTemp')?.addEventListener('click', () => {
      this.switchView('addProduct');
    });

    this.dom.btnSettle?.addEventListener('click', () => this.openSettleModal());
    this.dom.btnConfirmSettle?.addEventListener('click', () => this.confirmSettle());
    this.dom.btnCancelSettle?.addEventListener('click', () => this.closeSettleModal());

    this.dom.btnAddPaymentLine?.addEventListener('click', () => this.handleAddPaymentLine());

    this.dom.btnReconFilter?.addEventListener('click', () => this.renderReconciliation());
    this.dom.btnAuditFilter?.addEventListener('click', () => this.renderAuditLogs());

    this.dom.settleModal?.addEventListener('click', (e) => {
      if (e.target.classList.contains('modal-backdrop')) {
        this.closeSettleModal();
      }
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (this.dom.settleModal?.classList.contains('show')) {
          this.closeSettleModal();
        }
      }

      // ---- Barcode scanner support ----
      // Scanners send characters rapidly (< 30ms between keystrokes) followed by Enter.
      // We buffer rapid keystrokes and treat them as a barcode when Enter arrives.
      const now = Date.now();
      const activeTag = document.activeElement?.tagName;
      const isInputFocused = activeTag === 'INPUT' || activeTag === 'TEXTAREA' || activeTag === 'SELECT';

      if (!isInputFocused && this.dom.posSection?.classList.contains('active')) {
        if (now - this._lastBarcodeKeyTime < 50) {
          // Rapid keystroke → part of a barcode scan
          if (e.key.length === 1) { // Printable character only
            this._barcodeBuffer += e.key;
          }
        } else if (e.key.length === 1) {
          // First character of a potential barcode
          this._barcodeBuffer = e.key;
        }
        this._lastBarcodeKeyTime = now;

        if (e.key === 'Enter' && this._barcodeBuffer.length >= 4) {
          e.preventDefault();
          e.stopPropagation();
          const barcode = this._barcodeBuffer.trim();
          this._barcodeBuffer = '';

          // Search product by barcode
          const product = this.products.find(p => p.barcode === barcode);
          if (product) {
            this.addToCart(product);
            showToast('toastSuccess');
          } else {
            // Also check SKUs
            let found = false;
            for (const p of this.products) {
              const sku = (p.skus || []).find(s => s.barcode === barcode);
              if (sku) {
                this.addSkuToCart(p, sku);
                found = true;
                break;
              }
            }
            if (!found) {
              showToast('toastError');
            }
          }
          return; // Don't process Enter for settle modal
        }
      }

      if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && this.dom.posSection?.classList.contains('active')) {
        if (this.dom.settleModal?.classList.contains('show')) {
          this.confirmSettle();
        } else if (this.cart.length > 0 && document.activeElement?.tagName !== 'INPUT') {
          this.openSettleModal();
        }
      }

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'l') {
        e.preventDefault();
        this.clearCart();
      }
    });

    // 日期筛选器事件
    const yearSelect = document.getElementById('filterYear');
    const monthSelect = document.getElementById('filterMonth');
    const daySelect = document.getElementById('filterDay');

    yearSelect?.addEventListener('change', () => {
      const month = monthSelect ? parseInt(monthSelect.value) : 0;
      updateDayOptions(yearSelect.value, month);
      this.updateMainStats();
      this.renderSalesChart();
    });

    monthSelect?.addEventListener('change', () => {
      const year = yearSelect ? yearSelect.value : new Date().getFullYear();
      const month = parseInt(monthSelect.value);
      updateDayOptions(year, month);
      this.updateMainStats();
      this.renderSalesChart();
    });

    daySelect?.addEventListener('change', () => {
      this.updateMainStats();
    });

    // 记录按钮事件
    document.getElementById('btnRecord')?.addEventListener('click', () => {
      const yearSelect = document.getElementById('filterYear');
      const monthSelect = document.getElementById('filterMonth');
      const daySelect = document.getElementById('filterDay');

      const year = yearSelect ? yearSelect.value : new Date().getFullYear();
      const month = monthSelect ? parseInt(monthSelect.value) : 0;
      const day = daySelect ? parseInt(daySelect.value) : 0;

      const stats = getFilteredStats(this.transactions, year, month, day);

      let dateStr = `${year}年`;
      if (month > 0) dateStr += `${month}月`;
      if (day > 0) dateStr += `${day}日`;

      alert(`${dateStr}\n销售额：¥${formatPrice(stats.amount)}\n销售数量：${stats.count} 笔\n\n数据已记录！`);
    });

    // 登录与退出
    document.getElementById('loginForm')?.addEventListener('submit', (e) => this.login(e));
    document.getElementById('btnLogout')?.addEventListener('click', () => this.logout());

    // 强制修改密码表单
    this.dom.changePasswordForm?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const oldPwd = document.getElementById('oldPassword').value;
      const newPwd = document.getElementById('newPassword').value;
      const confirmPwd = document.getElementById('confirmPassword').value;
      const errorEl = document.getElementById('pwdError');

      if (newPwd !== confirmPwd) {
        errorEl.textContent = '两次输入的新密码不一致';
        return;
      }

      const btn = e.target.querySelector('button');
      btn.disabled = true;
      btn.textContent = '保存并进入中...';

      const result = await SyncManager.changePassword(oldPwd, newPwd);
      if (result.code === 200) {
        showToast('toast');
        this.currentUser.must_change_password = 0;
        localStorage.setItem('pos_user', JSON.stringify(this.currentUser));
        this.dom.changePasswordModal.classList.remove('show');
        this.updateUserUI();
      } else {
        errorEl.textContent = result.message || '修改失败，请检查原密码';
      }
      btn.disabled = false;
      btn.textContent = '确认修改并进入系统';
    });

    this.dom.btnCancelSku?.addEventListener('click', () => {
      this.dom.skuModal.classList.remove('show');
    });
  }

  checkStockLevels() {
    const lowStockItems = this.products.filter(p => (p.stock !== undefined ? p.stock : 9999) < 10);
    const badge = document.getElementById('stockWarningBadge');
    if (badge) {
      badge.textContent = lowStockItems.length;
      badge.style.display = lowStockItems.length > 0 ? 'inline-block' : 'none';
    }
  }

  printReceipt(tx) {
    const config = this.getReceiptConfig();
    const dateStr = new Date(tx.time).toLocaleString('zh-CN');
    const itemsHtml = (tx.items || []).map(item =>
      `<tr><td style="text-align:left;">${item.name}</td><td style="text-align:center;">x${item.qty}</td><td style="text-align:right;">¥${(item.price * item.qty).toFixed(2)}</td></tr>`
    ).join('');

    const paymentsHtml = (tx.payments || []).map(p =>
      `<div style="display:flex;justify-content:space-between;"><span>${p.method || '现金'}</span><span>¥${Number(p.amount).toFixed(2)}</span></div>`
    ).join('');

    const storeName = config.storeName || '如意收银';
    const storePhone = config.storePhone || '';
    const storeAddr = config.storeAddr || '';
    const footer = config.footer || '感谢惠顾，欢迎再次光临！';

    const receiptHtml = `
      <div id="receiptContent" style="font-family:'Noto Sans SC',monospace;max-width:320px;margin:0 auto;padding:10px;font-size:13px;">
        <div style="text-align:center;margin-bottom:8px;">
          <h2 style="margin:0;font-size:18px;">${storeName}</h2>
          ${storePhone ? `<p style="margin:2px 0;color:#555;">tel: ${storePhone}</p>` : ''}
          ${storeAddr ? `<p style="margin:2px 0;color:#555;">${storeAddr}</p>` : ''}
        </div>
        <div style="border-top:1px dashed #333;border-bottom:1px dashed #333;padding:6px 0;margin:6px 0;">
          <div style="display:flex;justify-content:space-between;"><span>订单号:</span><span>${(tx.order_no || tx.id || '').substring(0, 16)}</span></div>
          <div style="display:flex;justify-content:space-between;"><span>时间:</span><span>${dateStr}</span></div>
          ${(tx.cashier_id || tx.processed_by) ? `<div style="display:flex;justify-content:space-between;"><span>收银员:</span><span>${tx.cashier_id || tx.processed_by || ''}</span></div>` : ''}
        </div>
        <table style="width:100%;border-collapse:collapse;margin-top:8px;">
          <thead><tr style="border-bottom:1px solid #333;">
            <th style="text-align:left;padding:4px 0;font-size:12px;">商品</th>
            <th style="text-align:center;padding:4px 0;font-size:12px;">数量</th>
            <th style="text-align:right;padding:4px 0;font-size:12px;">金额</th>
          </tr></thead>
          <tbody>${itemsHtml}</tbody>
        </table>
        <div style="border-top:1px dashed #333;margin-top:8px;padding-top:8px;">
          ${paymentsHtml}
          <div style="display:flex;justify-content:space-between;font-size:16px;font-weight:bold;margin-top:6px;border-top:1px solid #333;padding-top:6px;">
            <span>合计</span><span>¥${parseFloat(tx.total || tx.amount).toFixed(2)}</span>
          </div>
        </div>
        <div style="text-align:center;margin-top:16px;color:#888;font-size:11px;">
          <p style="margin:2px 0;">${footer}</p>
        </div>
      </div>
    `;

    // Show preview in a modal first
    const modal = document.createElement('div');
    modal.className = 'modal-backdrop';
    modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:10000;';
    modal.innerHTML = `
      <div style="background:#fff;border-radius:12px;padding:20px;max-width:400px;width:95%;max-height:90vh;overflow-y:auto;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
          <h3 style="margin:0;">小票预览</h3>
          <button id="btnCloseReceiptPreview" style="background:none;border:none;font-size:20px;cursor:pointer;color:#999;">&times;</button>
        </div>
        <div style="border:1px dashed #ddd;padding:12px;background:#fafafa;border-radius:4px;">
          ${receiptHtml}
        </div>
        <div style="display:flex;gap:8px;margin-top:16px;">
          <button id="btnDoPrint" style="flex:1;padding:10px;background:var(--primary);color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:14px;">🖨️ 打印</button>
          <button id="btnCancelPrint" style="flex:1;padding:10px;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:6px;cursor:pointer;font-size:14px;">取消</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    modal.querySelector('#btnCloseReceiptPreview').onclick = () => modal.remove();
    modal.querySelector('#btnCancelPrint').onclick = () => modal.remove();
    modal.querySelector('#btnDoPrint').onclick = () => {
      // Open print window with @media print optimized styles
      const printWin = window.open('', '_blank', 'width=400,height=600');
      printWin.document.write(`<!DOCTYPE html><html><head><title>小票 - ${storeName}</title>
      <style>
        @page { size: 80mm auto; margin: 0; }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: 'Noto Sans SC', monospace; padding: 5mm; font-size: 13px; color: #000; }
        @media print {
          body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
        }
        #receiptContent { max-width: 72mm; margin: 0 auto; }
        #receiptContent h2 { text-align: center; font-size: 16px; margin-bottom: 4px; }
        #receiptContent p { text-align: center; margin: 2px 0; color: #555; font-size: 11px; }
        #receiptContent table { width: 100%; border-collapse: collapse; margin-top: 8px; }
        #receiptContent td, #receiptContent th { padding: 3px 0; font-size: 12px; }
        #receiptContent thead tr { border-bottom: 1px solid #000; }
        #receiptContent tbody tr { border-bottom: 1px dashed #ccc; }
        #receiptContent .total { font-size: 15px; font-weight: bold; text-align: right; margin-top: 8px; }
        #receiptContent .footer { text-align: center; margin-top: 12px; color: #888; font-size: 10px; }
      </style></head><body>${receiptHtml}</body></html>`);
      printWin.document.close();
      setTimeout(() => { printWin.print(); }, 300);
      modal.remove();
    };

    // Close on backdrop click
    modal.addEventListener('click', (e) => {
      if (e.target === modal) modal.remove();
    });
  }

  getReceiptConfig() {
    try {
      return JSON.parse(localStorage.getItem('pos_receipt_config') || '{}');
    } catch {
      return {};
    }
  }

  saveReceiptConfig() {
    const config = {
      storeName: document.getElementById('receiptStoreName')?.value.trim() || '',
      storePhone: document.getElementById('receiptStorePhone')?.value.trim() || '',
      storeAddr: document.getElementById('receiptStoreAddr')?.value.trim() || '',
      footer: document.getElementById('receiptFooter')?.value.trim() || ''
    };
    localStorage.setItem('pos_receipt_config', JSON.stringify(config));
    showToast('toastSuccess');
  }

  loadReceiptConfig() {
    const config = this.getReceiptConfig();
    const nameEl = document.getElementById('receiptStoreName');
    const phoneEl = document.getElementById('receiptStorePhone');
    const addrEl = document.getElementById('receiptStoreAddr');
    const footerEl = document.getElementById('receiptFooter');
    if (nameEl) nameEl.value = config.storeName || '';
    if (phoneEl) phoneEl.value = config.storePhone || '';
    if (addrEl) addrEl.value = config.storeAddr || '';
    if (footerEl) footerEl.value = config.footer || '';
  }

  async refundTransaction(txId) {
    const reason = prompt('请输入退款原因（可选）：') || '';
    try {
      const result = await SyncManager.requestRefund(txId, reason);
      if (result && result.code === 200) {
        alert('退款申请已提交！待审批通过后库存将自动回补。');
        this.initialCloudPull().then(() => {
          if (this.currentView === 'history') this.renderHistory();
          this.updateStatsUI();
        });
      } else {
        alert('退款申请失败：' + ((result && result.message) || '请稍后重试'));
      }
    } catch (err) {
      console.error('refundTransaction error:', err);
      alert('网络异常，请稍后重试');
    }
  }

  openInventoryAdjustModal() {
    const role = this.currentUser?.role;
    if (!['merchant_admin', 'store_manager'].includes(role)) return;

    // 填充门店列表
    const storeSelect = document.getElementById('adjustStoreId');
    const storeGroup = document.getElementById('adjustStoreGroup');
    if (storeSelect && this.stores.length > 0 && role === 'merchant_admin') {
      storeGroup.style.display = 'block';
      storeSelect.innerHTML = this.stores.map(s => '<option value="' + s.id + '">' + escapeHtml(s.name) + '</option>').join('');
    } else if (role === 'store_manager') {
      storeGroup.style.display = 'none';
      if (storeSelect) storeSelect.value = this.currentUser.store_id || '';
    }

    // 重置表单
    document.getElementById('adjustProductSearch').value = '';
    document.getElementById('adjustProductResults').style.display = 'none';
    document.getElementById('adjustProductId').value = '';
    document.getElementById('adjustSkuId').value = '';
    document.getElementById('adjustSelectedProduct').textContent = '';
    document.getElementById('adjustQty').value = '';
    document.getElementById('adjustReason').value = '';
    document.getElementById('adjustError').textContent = '';

    this.dom.inventoryAdjustModal?.classList.add('show');
  }

  onAdjustProductSearch(keyword) {
    const resultsEl = document.getElementById('adjustProductResults');
    if (!keyword || keyword.length < 1) {
      resultsEl.style.display = 'none';
      return;
    }

    const kw = keyword.toLowerCase();
    const matched = this.products.filter(p =>
      p.name.toLowerCase().includes(kw) || (p.barcode && p.barcode.includes(kw))
    ).slice(0, 8);

    if (matched.length === 0) {
      resultsEl.style.display = 'none';
      return;
    }

    resultsEl.style.display = 'block';
    resultsEl.innerHTML = matched.map(p => {
      const hasSKUs = p.skus && p.skus.length > 1;
      if (!hasSKUs) {
        const sku = p.skus && p.skus.length === 1 ? p.skus[0] : null;
        return '<div class="adjust-result-item" data-product-id="' + p.id + '" data-sku-id="' + (sku ? sku.id : '') + '" data-name="' + escapeHtml(p.name) + '" style="padding:8px 12px;cursor:pointer;border-bottom:1px solid var(--border);">' + escapeHtml(p.name) + (sku && sku.specName && sku.specName !== "标准" ? ' [' + escapeHtml(sku.specName) + ']' : '') + ' <small style="color:var(--text-muted);">库存: ' + (sku ? sku.stock : p.stock) + '</small></div>';
      }
      return p.skus.map(sku =>
        '<div class="adjust-result-item" data-product-id="' + p.id + '" data-sku-id="' + sku.id + '" data-name="' + escapeHtml(p.name + ' [' + sku.specName + ']') + '" style="padding:8px 12px;cursor:pointer;border-bottom:1px solid var(--border);">' + escapeHtml(p.name) + ' [' + escapeHtml(sku.specName) + '] <small style="color:var(--text-muted);">库存: ' + sku.stock + '</small></div>'
      ).join('');
    }).join('');

    resultsEl.querySelectorAll('.adjust-result-item').forEach(el => {
      el.addEventListener('click', () => {
        document.getElementById('adjustProductId').value = el.dataset.productId;
        document.getElementById('adjustSkuId').value = el.dataset.skuId;
        document.getElementById('adjustSelectedProduct').textContent = '已选择：' + el.dataset.name;
        document.getElementById('adjustProductSearch').value = '';
        resultsEl.style.display = 'none';
      });
    });
  }

  async handleInventoryAdjust() {
    const product_id = document.getElementById('adjustProductId').value;
    const sku_id = document.getElementById('adjustSkuId').value;
    const qty = parseInt(document.getElementById('adjustQty').value);
    const reason = document.getElementById('adjustReason').value.trim();
    const errorEl = document.getElementById('adjustError');
    const role = this.currentUser?.role;

    let store_id;
    if (role === 'merchant_admin') {
      store_id = document.getElementById('adjustStoreId').value;
    } else {
      store_id = this.currentUser?.store_id;
    }

    if (!product_id && !sku_id) { errorEl.textContent = '请先选择商品'; return; }
    if (isNaN(qty) || qty === 0) { errorEl.textContent = '请输入有效的调整数量'; return; }
    errorEl.textContent = '';

    try {
      const result = await SyncManager.adjustInventory({ store_id, product_id: product_id || undefined, sku_id: sku_id || undefined, qty, reason });
      if (result && result.code === 200) {
        alert('库存调整成功！');
        this.dom.inventoryAdjustModal?.classList.remove('show');
        this.initialCloudPull().then(() => {
          this.renderProducts();
          this.renderProductsPage();
          this.checkStockLevels();
        });
      } else {
        errorEl.textContent = '调整失败：' + ((result && result.message) || '请稍后重试');
      }
    } catch (err) {
      errorEl.textContent = '网络异常，请稍后重试';
    }
  }

  migrateToSKUs() {
    let changed = false;
    this.products.forEach(p => {
      if (!p.skus) {
        // 创建默认 SKU
        p.skus = [{
          id: p.id + '_s1',
          specName: '标准',
          price: p.price,
          stock: p.stock || 0,
          barcode: p.barcode || ''
        }];
        // 保留原字段以防万一，但逻辑将主要基于 skus
        changed = true;
      }
    });
    if (changed) {
      saveProducts(this.products);
      SyncManager.syncProducts(this.products);
    }
  }

  async handleSubordinateSubmit() {
    const name = document.getElementById('subName').value.trim();
    const username = document.getElementById('subUsername').value.trim();
    const password = document.getElementById('subPassword').value.trim();
    const storeId = document.getElementById('subStoreId').value;

    if (!username || !password || !name) {
      alert('请完整填写员工信息');
      return;
    }

    try {
      // 使用新的统一员工管理接口
      const resp = await SyncManager.request('/users', {
        method: 'POST',
        body: JSON.stringify({
          username,
          password,
          name,
          role: 'cashier', // 默认创建收银员，管理员可在后台调整或扩展 UI
          store_id: storeId
        })
      });

      if (resp.code === 200) {
        alert('员工添加成功！');
        this.dom.subordinateModal.style.display = 'none';
        this.dom.subordinateForm.reset();
        this.renderTeamReport(); // 刷新报表视图
      } else {
        alert(resp.message || '添加失败');
      }
    } catch (err) {
      console.error('Add staff failed:', err);
      alert('操作失败，请检查网络或权限');
    }
  }
}

const app = new POSApp();
app.init();
