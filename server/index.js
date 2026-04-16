require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { ApiResponse } = require('./utils');
const logger = require('./logger');

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

const app = express();
const DEFAULT_PORT = 3000;
const parsedPort = Number.parseInt(process.env.PORT || '', 10);
const PORT = Number.isInteger(parsedPort) && parsedPort > 0 ? parsedPort : DEFAULT_PORT;

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

const server = app.listen(PORT, () => {
    console.log(`POS Sync Server v1 running at http://localhost:${PORT}`);
});

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(
            `Port ${PORT} is already in use. Stop the existing process or set PORT in server/.env to a different value.`
        );
        process.exit(1);
    }

    console.error('Failed to start server:', err);
    process.exit(1);
});
