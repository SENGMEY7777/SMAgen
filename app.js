const { validateEnvironment } = require('./configs/env.js');

const config = validateEnvironment();

const express = require('express');
const compression = require('compression');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const http = require('http');
const {initializeWebSocket} = require('./core/websocket');
const dbPool = require('./configs/db');
const correlationMiddleware = require('./middleware/correlation');
const errorHandler = require('./middleware/errorHandler');
const { NotFoundError } = require('./utils/errors');

const app = express();
app.disable('x-powered-by');
app.set('json escape', true);
app.use(correlationMiddleware);

const server = http.createServer(app);
const io = initializeWebSocket(server);
app.set('io', io);
const authRoutes = require('./routes/admins/authRoutes');
const approveRoutes = require('./routes/admins/approveRoutes');
const developersRoutes = require('./routes/developers/developerRoute');
const workflowRoutes = require('./routes/workflow/workflowRoute');
const chatRoutes = require('./routes/chatRoute');

const corsOrigin = (origin, callback) => {
    const allowUnconfiguredDevelopmentOrigin = config.nodeEnv !== 'production'
        && config.corsOrigins.length === 0;

    if (
        !origin
        || allowUnconfiguredDevelopmentOrigin
        || config.corsOrigins.includes('*')
        || config.corsOrigins.includes(origin)
    ) {
        return callback(null, true);
    }

    const error = new Error('CORS origin is not allowed');
    error.statusCode = 403;
    return callback(error);
};

const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 300,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: {
        success: false,
        message: 'Too many requests. Please try again later.',
        error: {code: 'RATE_LIMITED'},
    },
});

app.use(helmet());
app.use(cors({
    origin: corsOrigin,
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use('/api', apiLimiter);
app.use(express.json({ limit: '10kb' }));
app.use(compression({
    threshold: '1kb',
    filter: (req, res) => {
        if (req.headers.accept === 'text/event-stream' || req.path.includes('/stream') || req.query?.stream === 'true') {
            return false;
        }
        return compression.filter(req, res);
    },
}));

app.use(express.static('public'));
app.use('/api/v1/admin/auth', authRoutes);
app.use('/api/v1/admin/approvals', approveRoutes);
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/developers', developersRoutes);
app.use('/api/v1/developer/auth', developersRoutes);
app.use('/api/v1/workflow', workflowRoutes);
app.use('/api/v1/workflows', workflowRoutes);
app.use('/api/v1/chat', chatRoutes);

app.get('/', (req, res) => {
    res.status(200).json({
        success: true,
        message: 'Kairo Backend API is live and operational',
        timestamp: new Date().toISOString(),
    });
});

app.get('/health', (req, res) => {
    res.status(200).json({
        status: 'UP',
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
    });
});

app.use((req, res, next) => {
    next(new NotFoundError(`Route ${req.method} ${req.originalUrl} not found`));
});

app.use(errorHandler);


const PORT = process.env.PORT || 5000;

let isShuttingDown = false;

const shutdown = async (signal) => {
    if (isShuttingDown) {
        return;
    }

    isShuttingDown = true;
    console.log(`[Shutdown] ${signal} received; draining connections`);

    const forceExit = setTimeout(() => {
        console.error('[Shutdown] Graceful shutdown timed out');
        process.exit(1);
    }, 30000);
    forceExit.unref();

    try {
        await io.close();
        await dbPool.end();
        clearTimeout(forceExit);
        console.log('[Shutdown] Complete');
        process.exit(0);
    } catch (error) {
        console.error('[Shutdown] Failed', error);
        process.exit(1);
    }
};

process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
process.on('message', (message) => {
    if (message === 'shutdown') {
        void shutdown('PM2 shutdown message');
    }
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is running on port ${PORT}`);
    if (typeof process.send === 'function') {
        process.send('ready');
    }
});

module.exports = {
    app,
    server,
    shutdown,
};
