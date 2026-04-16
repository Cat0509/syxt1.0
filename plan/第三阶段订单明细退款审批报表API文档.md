# 第三阶段订单明细退款审批报表 API 文档

更新日期：2026-04-07

说明：
- 本文档已按当前仓库实现更新，以 `server/routes/*.js` 为准
- 虽然文档名称仍保留“第三阶段”，但内容已同步当前代码口径，包含部分第四阶段兼容字段

## 1. 通用约定

- 基础前缀：`/api/v1`
- 认证方式：`Authorization: Bearer <token>`
- 统一返回结构：

```json
{
  "code": 200,
  "message": "Success",
  "data": {},
  "timestamp": 1775445000000
}
```

- 成功响应默认 HTTP `200`
- 错误响应会根据场景返回 HTTP `400/401/403/404/409/500`
- 角色范围：
  - `merchant_admin` 可跨店访问，未传 `store_id` 时多数查询默认可看全部门店
  - `store_manager`、`cashier` 固定只能访问本人所属门店
  - `store_manager`、`cashier` 主动传入其他门店 `store_id` 时会被 `403` 拒绝
- 关键订单状态：
  - `pending`
  - `paid`
  - `cancelled`
  - `refund_requested`
  - `refunded`
- 关键支付状态：
  - `unpaid`
  - `paid`
  - `refunded`
- 支付方式枚举：
  - `cash`
  - `scan`
  - `card`

## 2. 订单接口

### 2.1 `GET /api/v1/orders`

用途：
- 历史订单列表
- 订单详情查询
- 支付结果轮询

权限：
- `merchant_admin`
- `store_manager`
- `cashier`

支持参数：
- `store_id`
- `start_time`
- `end_time`
- `status`
- `order_id`
- `payment_status`
- `client_tx_id`

行为说明：
- 返回当前商户下的订单数组
- 每条订单都会带 `items`
- 查询订单明细时，优先读取 `order_items`
- 如果历史订单没有 `order_items`，会回退读取旧 `transactions.items`
- `merchant_admin` 传 `store_id` 时按门店过滤；不传时可查全部门店
- `store_manager`、`cashier` 永远只看本人门店

### 2.2 `POST /api/v1/orders`

用途：
- 创建一笔正常收银订单

权限：
- `merchant_admin`
- `store_manager`
- `cashier`

请求字段：
- 必填：
  - `client_tx_id`
  - `items`
- 常用：
  - `total`
  - `amount`
  - `payment_method`
  - `payment`
  - `device_id`
  - `order_no`
  - `store_id`

字段说明：
- `items` 必须是非空数组
- `payment` 默认为 `{}`
- `payment_method` 默认为 `scan`
- `device_id` 为可选字段，创建订单时会直接写入 `transactions.device_id`
- `order_no` 可自定义；未传时由后端自动生成
- `merchant_admin` 创建订单时必须通过请求体传 `store_id`
- `store_manager`、`cashier` 会自动使用本人所属门店，传其他门店会被拒绝

行为说明：
- 新订单创建后状态为 `pending/unpaid`
- 同时写入 `transactions`
- 新写入的 `transactions.items` 固定写成 `'[]'`，不再作为主明细来源
- 同时写入 `order_items`
- 同时扣减 `inventory`
- 同时写入 `inventory_movements(type=sale)`
- 同时写入审计日志 `CREATE_ORDER`
- `client_tx_id` 具备幂等约束，重复提交会返回 `409`
- 库存不足会返回 `400`

成功返回示例：

```json
{
  "code": 200,
  "message": "Order created successfully",
  "data": {
    "order_id": "793979e9-7612-42d3-b9b6-04cfb9bdaee2",
    "order_no": "S1-20260406-5019"
  },
  "timestamp": 1775445000000
}
```

### 2.3 `POST /api/v1/orders/replay`

用途：
- 批量回放离线订单

权限：
- `merchant_admin`
- `store_manager`
- `cashier`

最小请求体：

```json
{
  "orders": [
    {
      "client_tx_id": "offline_xxx",
      "items": []
    }
  ]
}
```

单笔订单常用字段：
- `client_tx_id`
- `items`
- `total`
- `amount`
- `payment`
- `payment_method`
- `order_no`
- `store_id`
- `device_id`

行为说明：
- 接口本身返回 HTTP `200`
- 每一笔回放结果写在 `data.results[]`
- `merchant_admin` 通常应在每个离线订单内携带 `store_id`
- `store_manager`、`cashier` 未传 `store_id` 时会自动使用本人门店
- 回放成功时订单直接写成 `paid/paid`
- 回放失败时按单失败，不会出现“只扣一半库存”
- `client_tx_id` 已同步过时，单笔结果 `code = 409`
- 库存不足、缺少 `store_id` 等情况，单笔结果 `code = 400`

结果语义：
- `results[].code = 200`：回放成功
- `results[].code = 409`：同一 `client_tx_id` 已同步
- `results[].code = 400`：库存不足或请求数据不完整

## 3. 退款接口

### 3.1 `GET /api/v1/refunds`

用途：
- 查看退款申请列表

权限：
- `merchant_admin`
- `store_manager`
- `cashier`

支持参数：
- `status`
- `store_id`

返回要点：
- 返回 `refunds` 主表字段
- 额外带出：
  - `store_id`
  - `order_no`
  - `order_total`
  - `requester_name`
- 按 `created_at DESC` 排序

权限说明：
- `merchant_admin` 可按 `store_id` 跨店筛选
- `store_manager`、`cashier` 只允许查看本人门店退款
- 非管理员手工传其他门店 `store_id` 时返回 `403`

### 3.2 `POST /api/v1/refunds`

用途：
- 发起退款申请

权限：
- `merchant_admin`
- `store_manager`
- `cashier`

请求字段：
- 必填：
  - `order_id`
- 可选：
  - `reason`

行为说明：
- 仅 `status = paid` 的订单可申请退款
- 创建 `refunds(status=requested)`
- 同时将订单状态更新为 `refund_requested`
- 同时写入审计日志 `REFUND_REQUESTED`
- `store_manager`、`cashier` 只能操作本人门店订单

### 3.3 `PATCH /api/v1/refunds/:id/approve`

用途：
- 审批通过退款

权限：
- `merchant_admin`
- `store_manager`

行为说明：
- 仅 `status = requested` 的退款申请可审批
- 店长只能审批自己门店的退款
- 根据 `order_items` 明细逐条回补 `inventory`
- 同时写入 `inventory_movements(type=refund)`
- 退款单状态更新为 `approved`
- 订单状态更新为 `refunded`
- 订单支付状态更新为 `refunded`
- 同时写入审计日志 `REFUND_APPROVED`

### 3.4 `PATCH /api/v1/refunds/:id/reject`

用途：
- 拒绝退款申请

权限：
- `merchant_admin`
- `store_manager`

请求字段：
- 可选：
  - `reason`

行为说明：
- 仅 `status = requested` 的退款申请可拒绝
- 店长只能拒绝自己门店的退款
- 退款单状态更新为 `rejected`
- 如果传了 `reason`，会拼接到退款单原有 `reason` 字段后面
- 订单状态恢复为 `paid`
- 同时写入审计日志 `REFUND_REJECTED`

## 4. 报表接口

### 4.1 `GET /api/v1/reports/summary`

用途：
- 汇总销售额、订单数、退款额、支付方式分布

权限：
- `merchant_admin`
- `store_manager`
- `cashier`

支持参数：
- `store_id`
- `start_time`
- `end_time`

默认值：
- 未传时间范围时，默认取“今天 00:00:00 到今天 23:59:59”

返回要点：
- `time_range`
- `store_id`
- `summary.order_count`
- `summary.total_sales`
- `summary.refund_amount`
- `payment_distribution[]`

统计口径：
- `status IN ('paid', 'refund_requested')` 计入有效销售
- `status = 'refunded'` 计入退款金额

### 4.2 `GET /api/v1/reports/sales`

用途：
- 返回按天聚合的销售趋势

权限：
- `merchant_admin`
- `store_manager`

支持参数：
- `store_id`
- `start_time`
- `end_time`

统计口径：
- 仅统计 `status IN ('paid', 'refund_requested')`
- 返回字段：
  - `date`
  - `order_count`
  - `total_sales`

### 4.3 `GET /api/v1/reports/products`

用途：
- 返回商品销售排行

权限：
- `merchant_admin`
- `store_manager`

支持参数：
- `store_id`
- `start_time`
- `end_time`
- `limit`

返回字段：
- `product_id`
- `sku_id`
- `name`
- `total_qty`
- `total_revenue`

统计口径：
- 仅统计 `status IN ('paid', 'refund_requested')`
- 默认 `limit = 10`

### 4.4 `GET /api/v1/reports/staff`

用途：
- 返回员工销售业绩

权限：
- `merchant_admin`
- `store_manager`

支持参数：
- `store_id`
- `start_time`
- `end_time`

返回字段：
- `cashier_id`
- `staff_name`
- `order_count`
- `total_sales`

统计口径：
- 仅统计 `status IN ('paid', 'refund_requested')`

### 4.5 `GET /api/v1/reports/hourly`

用途：
- 返回 24 小时小时趋势

权限：
- `merchant_admin`
- `store_manager`
- `cashier`

支持参数：
- `store_id`
- `start_time`
- `end_time`

默认值：
- 未传 `start_time` 时，默认从今天 00:00:00 开始统计
- `end_time` 可不传

返回要点：
- 总是补齐 24 个小时槽位
- 每个槽位字段：
  - `hour`
  - `count`
  - `amount`

## 5. 与支付最小闭环的关系

- 订单先由 `POST /orders` 创建为 `pending/unpaid`
- 再由 `POST /payments/create` 发起支付
- 如果 `method = cash`，支付会被立即标记为成功
- 如果是其他方式，订单先保持 `pending/unpaid`，再等待 mock 回调
- 前端可通过 `GET /orders?order_id=xxx` 轮询订单状态
- 状态变为 `paid/paid` 后，再进入小票打印与收银完成逻辑

支付详细对接方式见：
- `plan/第三阶段支付与离线回放最小对接文档.md`

## 6. 常见错误语义

- `400`
  - 请求字段缺失
  - 库存不足
  - 退款状态不允许当前操作
  - 回调数据不合法
- `401`
  - 未登录
  - 账号状态无效
- `403`
  - 越权访问其他门店
  - 角色不允许访问当前接口
- `404`
  - 订单不存在
  - 退款单不存在
- `409`
  - `POST /orders` 的 `client_tx_id` 重复
  - `POST /orders/replay` 某笔离线订单已同步
- `500`
  - 报表生成失败
  - 支付回调处理失败
