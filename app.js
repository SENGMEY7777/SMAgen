const { validateEnvironment } = require('./configs/env.js');

const config = validateEnvironment();

const express = require('express');
const compression = require('compression');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const http = require('http');
const {initializeWebSocket} = require('./core/websocket');

const app = express();
app.disable('x-powered-by');
app.set('json escape', true);

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
}));

app.use('/api/v1/admin/auth', authRoutes);
app.use('/api/v1/admin/approvals', approveRoutes);
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/developers', developersRoutes);
app.use('/api/v1/developer/auth', developersRoutes);
app.use('/api/v1/workflow', workflowRoutes);
app.use('/api/v1/workflows', workflowRoutes);
app.use('/api/v1/chat', chatRoutes);

app.use((req, res) => {
    res.status(404).json({
        success: false,
        message: 'Route not found',
        error: {code: 'NOT_FOUND'},
    });
});

app.use((error, req, res, next) => {
    if (res.headersSent) {
        return next(error);
    }

    const statusCode = Number.isInteger(error.statusCode) ? error.statusCode : 500;

    if (statusCode >= 500) {
        console.error('[HTTP Error]', error.message);
    }

    return res.status(statusCode).json({
        success: false,
        message: statusCode === 500 ? 'Internal server error' : 'Request rejected',
        error: {code: statusCode === 500 ? 'INTERNAL_ERROR' : 'REQUEST_ERROR'},
    });
});

app.get('/', (req, res) => {
  res.status(200).json({
    success: true,
    message: 'Kairo Backend API is live and operational',
    timestamp: new Date().toISOString()
  });
});

app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'success',
    message: 'CI/CD pipeline deployed successfully via GitHub Actions!c and testing',
    timestamp: new Date().toISOString()
  });
});

const PORT = process.env.PORT || 5000;

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is running on port ${PORT}`);
});
