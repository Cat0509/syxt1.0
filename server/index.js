require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { ApiResponse } = require('./utils');
const logger = require('./logger');
const db = require('./db');
const { startOrderTimeoutChecker } = require('./order_timeout');

const productRoutes = require('./routes/products');
const transactionRoutes = require('./routes/transactions');
const authRoutes = require('./routes/auth');
const auditRoutes = require('./routes/audit');
const storeRoutes = require('./routes/stores');
const userRoutes = require('./routes/users');
const orderRoutes = require('./routes/orders');
const inventoryRoutes = require('./routes/inventory');
const refundRoutes = require('./routes/refunds');
const reportRoutes = require('./routes/reports');
const paymentRoutes = require('./routes/payments');
const syncRoutes = require('./routes/sync');
const backupRoutes = require('./routes/backup');
const backupService = require('./backup_service');
const syncService = require('./sync_service');

const app = express();
const DEFAULT_PORT = 3000;
let serverInstance = null;
let servicesStarted = false;

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Request Logging
app.use((req, res, next) => {
    logger.info(`${req.method} ${req.url} - ${req.ip}`);
    next();
});

app.use('/api/v1/products', productRoutes);
app.use('/api/v1/transactions', transactionRoutes);
app.use('/api/v1/orders', orderRoutes);
app.use('/api/v1/inventory', inventoryRoutes);
app.use('/api/v1/refunds', refundRoutes);
app.use('/api/v1/reports', reportRoutes);
app.use('/api/v1/payments', paymentRoutes);
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/audit', auditRoutes);
app.use('/api/v1/stores', storeRoutes);
app.use('/api/v1/users', userRoutes);
app.use('/api/v1/sync', syncRoutes);
app.use('/api/v1/backup', backupRoutes);

app.get('/health', (req, res) => {
    ApiResponse.success(res, { status: 'OK' }, 'Server is healthy');
});

app.use((req, res) => {
    ApiResponse.error(res, 'API Endpoint not found', 404, 404);
});

app.use((err, req, res, next) => {
    logger.error('Unhandled Server Error', err);
    ApiResponse.error(res, err.message || 'Internal Server Error');
});

function resolvePort(port) {
    const parsedPort = Number.parseInt(port || process.env.PORT || '', 10);
    return Number.isInteger(parsedPort) && parsedPort > 0 ? parsedPort : DEFAULT_PORT;
}

function startBackgroundServices() {
    if (servicesStarted) return;

    // Start order timeout checker
    startOrderTimeoutChecker();

    // Start auto backup
    backupService.startAutoBackup();

    // Start sync loop automatically (local mode if no HQ URL configured)
    const hqUrl = process.env.HQ_SYNC_URL || null;
    // Defer reading merchant/store IDs until after first init-setup.
    // The sync loop can be fully configured later through /sync/loop/start.
    syncService.startSyncLoop({ hqUrl, merchantId: null, storeId: null });

    servicesStarted = true;
}

function stopBackgroundServices() {
    const { stopOrderTimeoutChecker } = require('./order_timeout');
    backupService.stopAutoBackup();
    stopOrderTimeoutChecker();
    syncService.stopSyncLoop();
    servicesStarted = false;
}

function startServer(options = {}) {
    if (serverInstance) return serverInstance;

    const port = resolvePort(options.port);
    process.env.PORT = String(port);

    // Initialize SQLite database before starting server.
    db.init();
    startBackgroundServices();

    serverInstance = app.listen(port, () => {
        console.log(`POS Sync Server v1 running at http://localhost:${port}`);
    });

    serverInstance.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            console.error(
                `Port ${port} is already in use. Stop the existing process or set PORT in server/.env to a different value.`
            );
        } else {
            console.error('Failed to start server:', err);
        }

        if (require.main === module) {
            process.exit(1);
        }
    });

    serverInstance.on('close', () => {
        serverInstance = null;
    });

    return serverInstance;
}

function stopServer(callback) {
    stopBackgroundServices();

    if (!serverInstance) {
        if (callback) callback();
        return;
    }

    const closingServer = serverInstance;
    serverInstance = null;
    closingServer.close(callback);
}

if (require.main === module) {
    startServer();
}

module.exports = {
    app,
    startServer,
    stopServer
};
