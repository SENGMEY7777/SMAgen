const rateLimit = require('express-rate-limit');

const rateLimitMessage = (message, code) => ({
    success: false,
    message,
    error: {code},
});

const authAttemptLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 5,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: rateLimitMessage(
        'Too many authentication attempts. Please try again later.',
        'AUTH_RATE_LIMITED',
    ),
});

const isProduction = String(process.env.NODE_ENV || '').trim().toLowerCase() === 'production';

const workflowRunLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: Number(process.env.WORKFLOW_RUN_LIMIT) || (isProduction ? 100 : 2000),
    keyGenerator: (req) => String(req.user?.id || req.ip),
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: rateLimitMessage(
        'Workflow run limit reached. Please try again later.',
        'WORKFLOW_RATE_LIMITED',
    ),
    skip: (req) => !isProduction && String(process.env.ENABLE_RATE_LIMITING || '').toLowerCase() !== 'true',
});

const chatLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: Number(process.env.CHAT_LIMIT) || (isProduction ? 200 : 2000),
    keyGenerator: (req) => String(req.user?.id || req.ip),
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: rateLimitMessage(
        'Chat limit reached. Please try again later.',
        'CHAT_RATE_LIMITED',
    ),
    skip: (req) => !isProduction && String(process.env.ENABLE_RATE_LIMITING || '').toLowerCase() !== 'true',
});

module.exports = {
    authAttemptLimiter,
    workflowRunLimiter,
    chatLimiter,
};
