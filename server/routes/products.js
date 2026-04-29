const express = require('express');
const router = express.Router();
const multer = require('multer');
const XLSX = require('xlsx');
const db = require('../db');
const syncService = require('../sync_service');
const { ApiResponse, asyncHandler } = require('../utils');
const { authenticate } = require('../middleware/auth');
const { requireRole, requireActiveUser, requireStoreScope } = require('../middleware/rbac');
const logger = require('../logger');

// Multer config for file upload (memory storage, 5MB limit)
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const ext = file.originalname.split('.').pop().toLowerCase();
        if (['xlsx', 'xls', 'csv'].includes(ext)) {
            cb(null, true);
        } else {
            cb(new Error('仅支持 .xlsx, .xls, .csv 格式'));
        }
    }
});

// 获取所有商品 (需要认证)
router.get('/', authenticate, requireActiveUser, requireRole(['merchant_admin', 'store_manager', 'cashier']), requireStoreScope, asyncHandler(async (req, res) => {
    const products = await db.getProducts(req.user.merchant_id, req.effectiveStoreId);
    ApiResponse.success(res, products);
}));

// 同步商品数据 (需要认证)
router.post('/sync', authenticate, requireActiveUser, requireRole(['merchant_admin', 'store_manager']), requireStoreScope, asyncHandler(async (req, res) => {
    const { products } = req.body;

    if (!Array.isArray(products)) {
        return ApiResponse.error(res, 'Invalid data format: products must be an array', 400, 400);
    }

    for (const p of products) {
        if (!p.id || !p.name) {
            return ApiResponse.error(res, `Invalid product data: missing id or name for ${JSON.stringify(p)}`, 400, 400);
        }
    }

    for (const p of products) {
        let targetStoreId = req.effectiveStoreId;
        if (req.user.role === 'merchant_admin') {
            targetStoreId = p.store_id || req.effectiveStoreId;
            if (!targetStoreId) {
                return ApiResponse.error(res, 'store_id is required for merchant admin product sync', 400, 400);
            }
        }
        await db.saveProduct({ ...p, store_id: targetStoreId }, req.user.merchant_id);
    }

    ApiResponse.success(res, { count: products.length }, 'Products synced successfully');
}));

// 批量导入商品 (Excel/CSV)
// 列名映射：商品编号(id)、商品名称(name)、条码(barcode)、分类(category)、价格(price)、库存(stock)
router.post('/import', authenticate, requireActiveUser, requireRole(['merchant_admin', 'store_manager']), requireStoreScope, upload.single('file'), asyncHandler(async (req, res) => {
    if (!req.file) {
        return ApiResponse.error(res, '请上传文件', 400, 400);
    }

    const storeId = req.effectiveStoreId || req.body.store_id;
    if (!storeId) {
        return ApiResponse.error(res, 'store_id is required', 400, 400);
    }

    try {
        const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

        if (rows.length === 0) {
            return ApiResponse.error(res, '文件中没有数据行', 400, 400);
        }

        // Column mapping (support multiple common header names)
        const colMap = {
            id: ['商品编号', '编号', 'id', 'ID', 'product_id', '产品编号'],
            name: ['商品名称', '名称', 'name', '产品名称', '品名'],
            barcode: ['条码', '条形码', 'barcode', 'Barcode', '条码号'],
            category: ['分类', '类别', 'category', '品类'],
            price: ['价格', '售价', 'price', '单价', '零售价'],
            stock: ['库存', 'stock', '数量', '当前库存']
        };

        // Detect column names from the first row's keys
        const headers = Object.keys(rows[0]);
        const detectedMap = {};

        for (const [field, aliases] of Object.entries(colMap)) {
            for (const header of headers) {
                const trimmed = header.trim();
                if (aliases.includes(trimmed)) {
                    detectedMap[field] = trimmed;
                    break;
                }
            }
        }

        // Validate required columns
        if (!detectedMap.name) {
            return ApiResponse.error(res, `未找到"商品名称"列，请检查表头。当前列：${headers.join(', ')}`, 400, 400);
        }

        let imported = 0;
        let skipped = 0;
        const errors = [];

        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            const name = String(row[detectedMap.name] || '').trim();

            if (!name) {
                skipped++;
                continue;
            }

            // Generate ID from barcode or auto-generate
            const barcode = detectedMap.barcode ? String(row[detectedMap.barcode] || '').trim() : '';
            const id = detectedMap.id ? String(row[detectedMap.id] || '').trim() : (barcode || `import_${Date.now()}_${i}`);
            const category = detectedMap.category ? String(row[detectedMap.category] || '').trim() : '';
            const price = detectedMap.price ? String(row[detectedMap.price] || '0').trim() : '0';
            const stock = detectedMap.stock ? Number(row[detectedMap.stock] || 0) : 0;

            if (!id) {
                skipped++;
                errors.push(`第 ${i + 2} 行：缺少商品编号`);
                continue;
            }

            try {
                await db.saveProduct({
                    id,
                    name,
                    barcode,
                    category,
                    price: String(parseFloat(price) || 0),
                    stock,
                    store_id: storeId
                }, req.user.merchant_id);
                imported++;
            } catch (err) {
                skipped++;
                errors.push(`第 ${i + 2} 行：${err.message}`);
            }
        }

        // Audit log
        await db.saveAuditLog({
            action: 'PRODUCTS_IMPORT',
            details: { imported, skipped, errors: errors.slice(0, 10), filename: req.file.originalname },
            store_id: storeId,
            user_id: req.user.id,
            username: req.user.username
        }, req.user.merchant_id);

        ApiResponse.success(res, { imported, skipped, errors: errors.slice(0, 20) }, `成功导入 ${imported} 个商品${skipped > 0 ? `，跳过 ${skipped} 个` : ''}`);
    } catch (err) {
        logger.error('Product import failed', err);
        ApiResponse.error(res, '文件解析失败：' + err.message, 500);
    }
}));

// 导出商品模板
router.get('/import-template', authenticate, requireActiveUser, requireRole(['merchant_admin', 'store_manager']), asyncHandler(async (req, res) => {
    const template = [
        { '商品编号': 'P001', '商品名称': '示例商品', '条码': '6901028001723', '分类': '饮料', '价格': '3.50', '库存': '100' },
        { '商品编号': 'P002', '商品名称': '示例商品2', '条码': '6901028001730', '分类': '零食', '价格': '5.00', '库存': '50' }
    ];

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(template);
    ws['!cols'] = [
        { wch: 15 }, { wch: 20 }, { wch: 18 }, { wch: 10 }, { wch: 10 }, { wch: 10 }
    ];
    XLSX.utils.book_append_sheet(wb, ws, '商品导入模板');

    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=product_import_template.xlsx');
    res.send(buf);
}));

// 删除商品 (需要认证)
router.delete('/:id', authenticate, requireActiveUser, requireRole(['merchant_admin', 'store_manager']), asyncHandler(async (req, res) => {
    const { id } = req.params;
    await db.deleteProduct(id, req.user.merchant_id);
    ApiResponse.success(res, { id }, 'Product deleted successfully');
}));

// 设置门店差异价格 (仅管理员和店长)
router.post('/store-price', authenticate, requireActiveUser, requireRole(['merchant_admin', 'store_manager']), requireStoreScope, asyncHandler(async (req, res) => {
    const { product_id, sku_id, price, store_id } = req.body;
    const targetStoreId = store_id || req.effectiveStoreId;

    if (!product_id || price === undefined) {
        return ApiResponse.error(res, 'product_id and price are required', 400);
    }

    if (!targetStoreId) {
        return ApiResponse.error(res, 'store_id is required', 400);
    }

    await db.saveStorePrice({
        store_id: targetStoreId,
        product_id,
        sku_id,
        price
    }, req.user.merchant_id);

    // Audit Log
    await db.saveAuditLog({
        action: 'STORE_PRICE_CHANGED',
        details: { product_id, sku_id, price, store_id: targetStoreId },
        store_id: targetStoreId,
        user_id: req.user.id,
        username: req.user.username
    }, req.user.merchant_id);

    ApiResponse.success(res, null, 'Store price updated successfully');
}));

module.exports = router;
