const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, 'app.js');
let text = fs.readFileSync(file, 'utf8');

if (!text.includes('fetchRefunds(storeId, status)')) {
    text = text.replace('  static async adjustInventory(payload) {',
`  static async fetchRefunds(storeId, status) {
    let path = '/refunds';
    const params = [];
    if (storeId) params.push(\`store_id=\${storeId}\`);
    if (status) params.push(\`status=\${status}\`);
    if (params.length) path += '?' + params.join('&');
    const result = await this.request(path);
    return result.code === 200 ? result.data : [];
  }

  static async adjustInventory(payload) {`);
}

if (!text.includes("viewId === 'refunds'")) {
    text = text.replace("    if (viewId === 'history') this.renderHistory();",
`    if (viewId === 'history') this.renderHistory();
    if (viewId === 'refunds') this.renderRefunds();`);
}

if (!text.includes("viewName === 'refunds'")) {
    text = text.replace("    else if (viewName === 'history') this.renderHistory();",
`    else if (viewName === 'history') this.renderHistory();
    else if (viewName === 'refunds') this.renderRefunds();`);
}

if (!text.includes('async renderRefunds()')) {
    text = text.replace('  updateCartUI() {\\r\\n    const totalItems = this.cart.reduce', 
`  async renderRefunds() {
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
          'pending': '<span style="color:var(--warning);">待审批</span>',
          'approved': '<span style="color:var(--accent);">已通过</span>',
          'rejected': '<span style="color:var(--danger);">已拒绝</span>'
        };
        const statusText = statusMap[r.status] || r.status;
        
        return \`
          <div class="history-item" data-id="\${r.id}">
            <div class="history-header">
              <div class="history-header-left">
                <span class="history-id">订单号: \${r.order_id}</span>
                <span class="history-time">\${dateStr}</span>
              </div>
              <div class="history-header-right">
                <span class="history-total">退款金额: ¥\${formatPrice(r.amount)}</span>
                \${statusText}
                <span style="font-size:12px;color:var(--text-muted);margin-left:8px;">申请人: \${r.requested_by || '未知'}</span>
              </div>
            </div>
            <div class="history-details" style="display:block; padding:10px 15px; background:var(--bg-light);">
              <p style="margin:0 0 10px 0;"><strong>退款原因：</strong> \${escapeHtml(r.reason || '无')}</p>
              \${r.status === 'pending' ? \\\`
                <div style="margin-top:10px; display:flex; gap:10px; justify-content:flex-end;">
                  <button class="btn-approve-refund" data-id="\${r.id}" style="padding:6px 16px; background:var(--accent); color:#fff; border:none; border-radius:4px; cursor:pointer;">同意退款</button>
                  <button class="btn-reject-refund" data-id="\${r.id}" style="padding:6px 16px; background:var(--danger); color:#fff; border:none; border-radius:4px; cursor:pointer;">拒绝退款</button>
                </div>
              \\\` : \\\`
                \${r.processed_by ? \\\`<p style="margin:0; font-size:12px; color:var(--text-muted);">处理人: \${r.processed_by} | 处理时间: \${new Date(r.processed_at).toLocaleString('zh-CN')}</p>\\\` : ''}
              \\\`}
            </div>
          </div>
        \`;
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
              btn.disabled = false;
            }
          } catch(err) {
            alert('网络异常');
            btn.disabled = false;
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
              btn.disabled = false;
            }
          } catch(err) {
            alert('网络异常');
            btn.disabled = false;
          }
        });
      });

    } catch (err) {
      console.error('Failed to fetch refunds:', err);
      this.dom.refundsList.innerHTML = '<div style="padding: 20px; text-align: center; color: var(--danger);">加载失败，请检查网络或稍后重试</div>';
    }
  }

  updateCartUI() {\\r\\n    const totalItems = this.cart.reduce`);
}

fs.writeFileSync(file, text, 'utf8');
console.log('patched');
