const { validateEnvironment } = require('./configs/env.js');

const config = validateEnvironment();

const express = require('express');
const os = require('os');
const path = require('path');
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
const logger = require('./utils/logger');

const app = express();
app.disable('x-powered-by');
app.set('json escape', true);
app.use(correlationMiddleware);

const workspaceRoot = path.resolve(
    process.env.WORKSPACE_ROOT
        || (config.nodeEnv === 'production'
            ? path.join(process.cwd(), 'workspaces')
            : path.join(os.tmpdir(), 'kairo-workspaces')),
);
const IMAGE_EXTENSION_PATTERN = /\.(?:png|jpe?g|gif|webp|svg)$/i;
const SAFE_WORKSPACE_SEGMENT = /^[A-Za-z0-9_-]{1,128}$/;

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

app.use(express.static(path.join(__dirname, 'public')));

// Generated images are served through a constrained route. Do not expose the
// entire workspace tree because it may contain source files or other artifacts.
app.get('/workspaces/:runId/:fileName', (req, res, next) => {
    const {runId, fileName} = req.params;

    if (
        !SAFE_WORKSPACE_SEGMENT.test(runId)
        || path.basename(fileName) !== fileName
        || !IMAGE_EXTENSION_PATTERN.test(fileName)
    ) {
        return next(new NotFoundError('Generated image not found'));
    }

    const imagePath = path.resolve(workspaceRoot, runId, fileName);
    const workspacePrefix = `${path.resolve(workspaceRoot)}${path.sep}`;

    if (!imagePath.startsWith(workspacePrefix)) {
        return next(new NotFoundError('Generated image not found'));
    }

    return res.sendFile(imagePath, {dotfiles: 'deny'}, (error) => {
        if (error && !res.headersSent) {
            next(error);
        }
    });
});

app.get('/stream', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'stream.html'));
});
app.get('/stream.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'stream.html'));
});
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

app.get('/health', async (req, res) => {
    let dbStatus = 'disconnected';
    try {
        await dbPool.query('SELECT 1');
        dbStatus = 'connected';
    } catch {
        // DB unreachable — reported below
    }

    const isHealthy = dbStatus === 'connected';
    const statusCode = isHealthy ? 200 : 503;

    res.status(statusCode).json({
        status: isHealthy ? 'UP' : 'DOWN',
        uptime: process.uptime(),
        database: dbStatus,
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
    logger.info(`Graceful shutdown initiated`, { signal, pid: process.pid });

    const forceExit = setTimeout(() => {
        logger.fatal('Graceful shutdown timed out', { signal });
        process.exit(1);
    }, 30000);
    forceExit.unref();

    server.close();

    try {
        await io.close();
        await dbPool.end();
        clearTimeout(forceExit);
        logger.info('Shutdown complete');
        process.exit(0);
    } catch (error) {
        logger.fatal('Shutdown failed', error);
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
    logger.info(`Server started`, { port: PORT, pid: process.pid, nodeEnv: process.env.NODE_ENV || 'development' });
    if (typeof process.send === 'function') {
        process.send('ready');
    }
});

module.exports = {
    app,
    server,
    shutdown,
};
